let _io = null;

function init(httpServer) {
  const { Server } = require('socket.io');
  _io = new Server(httpServer, {
    cors: { origin: '*' }, // let any browser connect 
  });
// When a customer opens the tracking page and connects:
  _io.on('connection', (socket) => {
    const { token } = socket.handshake.query;
    if (token) socket.join(`order:${token}`);
  });

  return _io;
}

function getIO() {
  return _io;
}

module.exports = { init, getIO };
