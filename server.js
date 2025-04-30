const mediasoup = require('mediasoup');
const { Server } = require('socket.io');
const http = require('http');

const rooms = {}; // roomName -> { peers: Map<socketId, peerData> }

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

let worker;
let router;

async function createWorker() {
  worker = await mediasoup.createWorker();
  console.log('Mediasoup Worker created');

  worker.on('died', () => {
    console.error('Mediasoup worker died — exiting...');
    process.exit(1);
  });

  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000
      }
    ]
  });

  console.log('Router created with media codecs');
}

createWorker();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinRoom', ({ roomName, userId }, callback) => {
    if (!rooms[roomName]) {
      rooms[roomName] = { peers: new Map() };
    }

    rooms[roomName].peers.set(socket.id, {
      socket,
      userId,
      transports: [],
      producers: [],
      consumers: []
    });

    socket.roomName = roomName;
    console.log(`User ${userId} joined room ${roomName}`);

    // Notify new client of existing producers in the room
    for (const [otherId, peer] of rooms[roomName].peers.entries()) {
      if (otherId !== socket.id) {
        for (const producer of peer.producers) {
          socket.emit('newProducer', {
            producerId: producer.id,
            kind: producer.kind,
            userId: peer.userId
          });
        }
      }
    }

    callback({ joined: true });
  });

  socket.on('getRouterRtpCapabilities', (_, callback) => {
    callback(router.rtpCapabilities);
  });

  socket.on('createTransport', async (_, callback) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
      stunServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" }
      ]
    });

    const peer = rooms[socket.roomName].peers.get(socket.id);
    peer.transports.push(transport);

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });

    console.log('Transport created', transport.id);
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }) => {
    const peer = rooms[socket.roomName]?.peers.get(socket.id);
    const transport = peer?.transports.find(t => t.id === transportId);

    if (!transport) {
      console.error('Transport not found for ID:', transportId);
      return;
    }

    await transport.connect({ dtlsParameters });
    console.log('Transport connected:', transportId);
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    if (!socket.roomName || !rooms[socket.roomName]) {
      console.error('Room not found when producing');
      return callback({ error: 'Room not found' });
    }

    const peer = rooms[socket.roomName].peers.get(socket.id);
    if (!peer) {
      console.error('Peer not found when producing');
      return callback({ error: 'Peer not found' });
    }

    // Find the transport in the peer's transports
    const transport = peer.transports.find(t => t.id === transportId);

    if (!transport) {
      console.error('Transport not found for produce:', transportId);
      return callback({ error: 'Transport not found' });
    }
  

    const producer = await transport.produce({ kind, rtpParameters });
    if (!peer.producers) {
      peer.producers = [];
    }

    peer.producers.push(producer);

    // Notify other peers in the same room
    for (const [otherSocketId, otherPeer] of rooms[socket.roomName].peers.entries()) {
      if (otherSocketId !== socket.id) {
        otherPeer.socket.emit('newProducer', {
          producerId: producer.id,
          kind,
          userId: peer.userId
        });
      }
    }

    callback({ id: producer.id });
    console.log('Producer created', producer.id);
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      console.error('Cannot consume producer', producerId);
      return;
    }

    const peer = rooms[socket.roomName].peers.get(socket.id);
    const transport = peer.transports.find(t => t.id === transportId);

    if (!transport) {
      console.error('No receiving transport found.');
      return;
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false
    });

    peer.consumers.push(consumer);

    callback({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });

    console.log('Consumer created', consumer.id);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const room = rooms[socket.roomName];
    if (room) {
      room.peers.delete(socket.id);
      console.log(`Socket ${socket.id} left room ${socket.roomName}`);
    }
  });
});

server.listen(3000, () => {
  console.log('Mediasoup server running at http://localhost:3000');
});
