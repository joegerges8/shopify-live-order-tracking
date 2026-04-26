let _io = null;

function init(httpServer) {
  const { Server } = require('socket.io');
  _io = new Server(httpServer, {
    cors: { origin: '*' },
  });

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
