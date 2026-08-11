const jwt = require('jsonwebtoken');

let _io = null;

// The dispatcher's live map room, one per store. Order-bound driver positions
// are pushed here as they arrive so the map moves without polling.
function dispatchRoom(storeId) {
  return `dispatch:${storeId}`;
}

// Every authenticated dashboard, regardless of store. A driver's own position
// carries no order with it, so there is no store it belongs to — and drivers
// are shared across all of them anyway.
const ALL_DISPATCH_ROOM = 'dispatch:all';

function init(httpServer) {
  const { Server } = require('socket.io');
  _io = new Server(httpServer, {
    cors: { origin: '*' }, // let any browser connect
  });
// When a customer opens the tracking page and connects:
  _io.on('connection', (socket) => {
    const { token, dispatch } = socket.handshake.query;
    if (token) socket.join(`order:${token}`);

    // When a dispatcher opens the live map. This room carries every driver's
    // position, not one order's, so unlike the tracking token it has to be
    // earned: only a valid admin token gets in, and only to its own store.
    if (dispatch) {
      try {
        const payload = jwt.verify(dispatch, process.env.JWT_SECRET);
        if (payload && payload.type === 'admin' && payload.storeId) {
          socket.join(dispatchRoom(payload.storeId));
          socket.join(ALL_DISPATCH_ROOM);
        }
      } catch {
        // Expired or forged token — no room. The map falls back to polling
        // the REST endpoint, which does its own auth and will 401 properly.
      }
    }
  });

  return _io;
}

function getIO() {
  return _io;
}

// Best-effort push to a store's dispatchers. Silently does nothing before the
// server has started or when the store id is unknown, so callers on the
// driver's write path never have to guard it.
function emitToDispatch(storeId, event, payload) {
  if (!_io || !storeId) return;
  _io.to(dispatchRoom(storeId)).emit(event, payload);
}

// Push to every open dashboard. Used for a driver's own position, which is not
// about any one store's order — see postMyLocation.
function emitToAllDispatch(event, payload) {
  if (!_io) return;
  _io.to(ALL_DISPATCH_ROOM).emit(event, payload);
}

module.exports = { init, getIO, emitToDispatch, emitToAllDispatch };
