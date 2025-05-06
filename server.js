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

    // Notify  existing producers of new producer in the room
    // for (const [otherId, peer] of rooms[roomName].peers.entries()) {
    //   if (otherId !== socket.id) {
    //     console.log(`- Peer ${otherId} (${peer.userId}) has ${peer.producers?.length || 0} producers`);
    //     for (const producer of peer.producers) {
    //       const kind = producer.kind || producer.appData?.kind || 'unknown';
    //       console.log(`  - Sending producer ${producer.id} (${kind}) from ${peer.userId}`);

    //       socket.emit('newProducer', {
    //         producerId: producer.id,
    //         kind,
    //         remoteuserId: peer.userId
    //       });
    //     }
    //   }
    // }

    callback({ joined: true });
  });

  // Handler to your server.js Socket.IO connection
  socket.on('getExistingProducers', () => {
    const room = rooms[socket.roomName];
    if (!room) {
      console.error('Room not found when getting existing producers');
      return;
    }
    
    const existingProducers = [];
    
    // Collect all producers from all peers in the room
    for (const [peerId, peer] of room.peers.entries()) {
      if (peerId !== socket.id && peer.producers && peer.producers.length > 0) {
        for (const producer of peer.producers) {
          existingProducers.push({
            producerId: producer.id,
            kind: producer.kind || producer.appData?.kind,
            userId: peer.userId
          });
        }
      }
    }
    
    console.log(`Sending ${existingProducers.length} existing producers to ${socket.id}`);
    socket.emit('existingProducers', existingProducers);
  });


  socket.on('getRouterRtpCapabilities', (_, callback) => {
    callback(router.rtpCapabilities);
  });

  socket.on('createTransport', async (_, callback) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [
          // Use this for deployments
          { ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        stunServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' }
        ]
      });
  
      // Add transport error handling
      transport.on('icestatechange', (iceState) => {
        console.log(`Transport ${transport.id} ICE state changed to ${iceState}`);
      });
  
      transport.on('dtlsstatechange', (dtlsState) => {
        console.log(`Transport ${transport.id} DTLS state changed to ${dtlsState}`);
        if (dtlsState === 'failed' || dtlsState === 'closed') {
          console.error(`Transport ${transport.id} DTLS state is ${dtlsState}`);
        }
      });
  
      const peer = rooms[socket.roomName]?.peers.get(socket.id);
      if (peer) {
        peer.transports.push(transport);
      } else {
        console.error('Peer not found for transport creation');
        return callback({ error: 'Peer not found' });
      }
  
      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
  
      console.log('Transport created', transport.id);
    } catch (err) {
      console.error('Error creating transport:', err);
      callback({ error: err.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }) => {
    const peer = rooms[socket.roomName]?.peers.get(socket.id);
    const transport = peer?.transports.find(t => t.id === transportId);

    if (!transport) {
      console.error('Transport not found for ID:', transportId);
      return;
    }

    if (transport.dtlsState === 'connected') {
      console.warn('Transport already connected:', transportId);
      return;
    }
  
    try {
      await transport.connect({ dtlsParameters });
      console.log('Transport connected:', transportId);
    } catch (err) {
      console.error('Transport connect error:', err);
    }

  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    
    try {
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
  
      const producer = await transport.produce({ 
        kind, 
        rtpParameters,
        appData: { kind } // Ensure kind is stored in appData
      });
  
      if (!peer.producers) {
        peer.producers = [];
      }
  
      peer.producers.push(producer);
      
      console.log(`Producer created: ${producer.id}, kind: ${kind}, user: ${peer.userId}`);
  
      // Notify other peers in the same room
      for (const [otherSocketId, otherPeer] of rooms[socket.roomName].peers.entries()) {
        if (otherSocketId !== socket.id) {
          console.log(`Notifying peer ${otherSocketId} about new ${kind} producer ${producer.id}`);
          otherPeer.socket.emit('newProducer', {
            producerId: producer.id,
            kind,
            remoteuserId: peer.userId
          });
        }
      }
  
      callback({ id: producer.id });
    } catch (err) {
      console.error('Error in produce:', err);
      callback({ error: err.message });
    }

  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    
    try {
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.error('Cannot consume producer', producerId);
        return callback({ error: 'Cannot consume producer' });
      }
  
      const room = rooms[socket.roomName];
      if (!room) {
        console.error('Room not found for consume');
        return callback({ error: 'Room not found' });
      }
  
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error('Peer not found for consume');
        return callback({ error: 'Peer not found' });
      }
  
      const transport = peer.transports.find(t => t.id === transportId);
      if (!transport) {
        console.error('Transport not found for consume:', transportId);
        return callback({ error: 'Transport not found' });
      }
  
      // Find the producer - we need to know which peer owns it to get the user ID
      let producerOwnerId = null;
      for (const [peerId, peerData] of room.peers.entries()) {
        const producer = peerData.producers?.find(p => p.id === producerId);
        if (producer) {
          producerOwnerId = peerData.userId;
          break;
        }
      }
  
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false
      });
  
      if (!peer.consumers) {
        peer.consumers = [];
      }
      
      peer.consumers.push(consumer);
  
      // Handle consumer events
      consumer.on('transportclose', () => {
        console.log(`Consumer's transport closed: ${consumer.id}`);
      });
  
      consumer.on('producerclose', () => {
        console.log(`Consumer's producer closed: ${consumer.id}`);
        // Could send notification to client here that the producer is gone
      });
  
      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerUserId: producerOwnerId
      });
  
      console.log(`Consumer created: ${consumer.id}, kind: ${consumer.kind}, for producer: ${producerId}`);
    } catch (err) {
      console.error('Error in consume:', err);
      callback({ error: err.message });
    }

  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const room = rooms[socket.roomName];
    if (room) {
      const peer = room.peers.get(socket.id);
      const userId = peer.userId;

      if (peer) {
        // Close all transports & producers
        peer.transports.forEach(t => t.close());
        peer.producers.forEach(p => p.close());
        peer.consumers.forEach(c => c.close());
      }

      room.peers.delete(socket.id);
      console.log(`Socket: ${socket.id} | userId:${userId} left room ${socket.roomName}`);
      console.log(`Cleaned up peer ${socket.id} |  userId:${userId}  from room ${socket.roomName}`);

      // Notify all remaining peers in the room about the user who left
      room.peers.forEach(remainingPeer => {
        if (remainingPeer.socket && remainingPeer.socket.connected) {
          remainingPeer.socket.emit('user-disconnected', { userId: userId });
        }
      });

      // to check to clean up empty rooms
      if (room.peers.size === 0) {
        delete rooms[socket.roomName];
        console.log(`Room ${socket.roomName} deleted as it's now empty`);
      }

    }
  });
});

server.listen(3000, () => {
  console.log('Mediasoup server running at http://localhost:3000');
});
