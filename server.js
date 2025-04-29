const mediasoup = require('mediasoup');
const { Server } = require('socket.io');
const http = require('http');
const rooms = {};  // roomName -> { peers: Map<socketId, PeerData> }

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: "*",   // Allow all for now (development only)
    methods: ["GET", "POST"]
  }
});

let worker;
let router;
let transports = [];
let producers = [];
let consumers = [];

async function createWorker() {
  worker = await mediasoup.createWorker();
  console.log('Mediasoup Worker created');

  worker.on('died', () => {
    console.error('Mediasoup worker died, exiting...');
    process.exit(1);
  });

  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
      },
    ],
  });

  console.log('Router created with media codecs');
}

createWorker();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('getRouterRtpCapabilities', (data, callback) => {
    callback(router.rtpCapabilities);
  });

  socket.on('createTransport', async (_, callback) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
  
    rooms[socket.roomName].peers.get(socket.id).transports.push(transport);
    socket.transport = transport;
  
    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });

    console.log("Transport created ",transport.id);
    
  });
  
  socket.on('connectTransport', async ({ transportId, dtlsParameters }) => {
    const transport = transports.find(t => t.id === transportId);
    await transport.connect({ dtlsParameters });
    console.log('Transport connected:', transportId);
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    const transport = rooms[socket.roomName].peers.get(socket.id).transports.find(t => t.id === transportId);
    const p = rooms[socket.roomName].peers.get(socket.id); //p = peer
    const producer = await transport.produce({ kind, rtpParameters });
  
    rooms[socket.roomName].peers.get(socket.id).producers.push(producer);
  
    // Notify other peers in the same room
    for (const [otherSocketId, peer] of rooms[socket.roomName].peers.entries()) {
      if (otherSocketId !== socket.id) {
        peer.socket.emit('newProducer', { 
          producerId: producer.id,
          kind,
          userId: p.userId // 👈 send this for frontend label
         });
      }
    }
  
    callback({ id: producer.id });
    console.log("producer created ",producer.id);
    
  });
  

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    const transport = transports.find(t => t.id === transportId);

    if (!router.canConsume({
      producerId,
      rtpCapabilities
    })) {
      console.error('Cannot consume');
      return;
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });

    consumers.push(consumer);

    callback({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });

    console.log('Consumer created:', consumer.id);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const room = rooms[socket.roomName];
    if (room) {
      room.peers.delete(socket.id);
      console.log(`Socket ${socket.id} left room ${socket.roomName}`);
    }
  });

  socket.on('joinRoom', ({ roomName, userId }, callback) => {
    // 1. Create room if doesn't exist
    if (!rooms[roomName]) {
      rooms[roomName] = { peers: new Map() };
    }
    
    // 2. Add this peer to the room
    rooms[roomName].peers.set(socket.id, {
      socket,
      userId,
      transports: [],
      producers: [],
      consumers: []
    });

    // 3. Store room name on socket for later
    socket.roomName = roomName;
  
    console.log(`User ${userId} joined room ${roomName}`);

    //  4. Notify the new user of existing producers in the room
    for (const [otherId, peer] of rooms[roomName].peers.entries()) {
      if (otherId !== socket.id) {
        for (const producer of peer.producers) {
          socket.emit('newProducer', {
            producerId: producer.id,
            kind: producer.kind
          });
        }
      }
    }
    callback({ joined: true });
  });

  
});

server.listen(3000, () => {
  console.log('Mediasoup server running at http://localhost:3000');
});
