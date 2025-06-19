const mediasoup = require('mediasoup');
const { Server } = require('socket.io');
const http = require('http');
const { start } = require('repl');

const rooms = {}; // roomName -> { peers: Map<socketId, peerData> }
const roomModerators = {};
const recordings = {};

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

      // first user becomes the moderator
      roomModerators[roomName] = userId;
      console.log(`${userId} is the moderator of room ${roomName}`);
      
    }

    rooms[roomName].peers.set(socket.id, {
      socket,
      userId,
      transports: [],
      producers: [],
      consumers: [],
      isMuted:false,
    });

    socket.roomName = roomName;
    console.log(`User ${userId} joined room ${roomName}`);

    const isModerator = roomModerators[roomName] === userId;
    callback({ joined: true,isModerator });
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

  socket.on('endCallForAll',({roomName,userId},callback) =>{
    console.log(`Ending call for all in room ${roomName} by user ${userId}`);
    try {
      console.log(`Ending call for all in room ${roomName} by user ${userId}`);

      if(rooms[roomName]){
        // noitify al peers that the cal is ending
        rooms[roomName].peers.forEach((peer,socketId) =>{
          peer.socket.emit('callEndedForAll',{'endedBY':userId});

          // close all transports,producers and consumers for ach peer
          peer.transports.forEach(t => t.close());
          peer.producers.forEach(p => p.close());
          peer.consumers.forEach(c => c.close());
          console.log(`Closed all transports, producers and consumers for peer ${socketId}`);
        });

        // delete the room
        delete rooms[roomName];
        console.log(`Room ${roomName} deleted after ending call for all by ${userId}`);

        if (callback){
          callback({ success: true, message: `Call ended for all in room ${roomName}` });
        }else{
          console.log(`Room ${roomName} not found`);
          if (callback) {
            callback({ success: false, message: `Room ${roomName} not found` });
          }
          
        }
      }
      
    } catch (error) {
      console.error('Error in endCallForAll:', error);
      if (callback) {
        callback({ success: false, message: error.message });
      }
    }
  });

  socket.on('leaveRoom',({roomName,userId},callback) =>{
    try {
      console.log(`User ${userId} is leaving room ${roomName}`);

      if (rooms[roomName]) {
        const peer = rooms[roomName].peers.get(socket.id);
        if (peer) {
          // Close all transports, producers, and consumers for the peer
          peer.transports.forEach(t => t.close());
          peer.producers.forEach(p => p.close());
          peer.consumers.forEach(c => c.close());
          console.log(`Closed all transports, producers, and consumers for user ${userId}`);
        }

        rooms[roomName].peers.delete(socket.id);
        console.log(`User ${userId} left room ${roomName}`);

        // Notify remaining peers in the room
        rooms[roomName].peers.forEach(remainingPeer => {
          if (remainingPeer.socket && remainingPeer.socket.connected) {
            remainingPeer.socket.emit('user-disconnected', { userId: userId });
          }
        });

        // Check to clean up empty rooms
        if (rooms[roomName].peers.size === 0) {
          delete rooms[roomName];
          console.log(`Room ${roomName} deleted as it's now empty`);
        }

        if (callback) {
          callback({ success: true, message: `User ${userId} left room ${roomName}` });
        }
      } else {
        console.log(`Room ${roomName} not found`);
        if (callback) {
          callback({ success: false, message: `Room ${roomName} not found` });
        }
      }
    } catch (error) {
      console.error('Error in leaveRoom:', error);
      if (callback) {
        callback({ success: false, message: error.message });
      }
    }
  });

  // Start/Stop teh meeting recording
  socket.on('toggleRecording',({roomName,userId},callback) =>{
    if (roomModerators[roomName] !== userId){
      return callback({error: "Only Moderators can control the recording"});
    }

    if (!recordings[roomName]){
      // start the recording
      recordings[roomName] = {
        isRecording:true,
        startTime: new Date(),
        recordingId: `recording-${roomName}-${Date.now()}`,
      };

      // Notify all the users/participant iin the room
      rooms[roomName].peers.forEach(peer => {
        peer.socket.emit('recordingStarted', {
          recordingId: recordings[roomName].recordingId,
          startTime: recordings[roomName].startTime
        });
      });

      callback({success:true,recording:recordings[roomName]});
    }else{
      // Stop the recording
      const recordingData = recordings[roomName];
      delete recordings[roomName];

      // Notify participants 
      rooms[roomName].peers.forEach(peer => {
        peer.socket.emit('recordingStopped',{
          duration:Date.now() - recordingData.startTime.getTime(),
          recordingId: recordingData.recordingId,
        });
      });

      callback({success:true,stopped:true});

    }
  });

  // Get the participants list
  socket.on('getParticipants',(callback) => {
    const room = rooms[socket.roomName];
    if (!room) {
      console.error('Room not found when getting participants');
      return callback({ error: 'Room not found' });
    }

    const participants = Array.from(room.peers.values()).map(peer => ({
      userId: peer.userId,
      isMuted: peer.isMuted,
      socketId: peer.socket.id,
      isMuted: peer.isMuted || false,
      isProducing:{
        audio: peer.producers?.some(p => p.kind === 'audio') || false,
        video: peer.producers?.some(p => p.kind === 'video') || false,
      }
    }));

    console.log(`Sending ${participants.length} participants to ${socket.id}`);
    callback({ participants,moderator:roomModerators[socket.roomName] });

  });

  // Mute all the participants 
  socket.on('muteAll',({roomName,userId},callback) =>{
    if (roomModerators[roomName] !==userId){
      return callback({error:'Only Moderators can call this action'});
    }

    const room = rooms[roomName];
    if (!room) return callback({error:'Room not found'});

    // Notify all particpants to mute themselves
    room.peers.forEach((peer,socketId) =>{
      if (socketId !== socket.id){ // dont mute the moderator
        peer.socket.emit('forceAudioMute');
        peer.isMuted = true;
      }
    });

    callback({ success: true, message: `All participants muted by ${userId}` });

  });

  // Remove a particpant in the room
  socket.on('kickParticipant',({roomName,userId,targetUserId},callback) =>{
    if (roomModerators[roomName] !== userId) {
      return callback({ error: 'Only moderator can kick participants' });
    }
    
    const room = rooms[roomName];
    if (!room) return callback({ error: 'Room not found' });

    // find the target party
    let targetSocket = null;
    for (const[socketId,peer] of room.peers.entries()){
      if (peer.userId === targetUserId) {
        targetSocket = peer.socket;
        break;
      }
    }

    if(targetSocket){
      targetSocket.emit('kicked',{by:userId});
      targetSocket.disconnect(true); // force disconnect the target user
      room.peers.delete(targetSocket.id);

      callback({ success: true, message: `User ${targetUserId} kicked by ${userId}` });
    }else{
      callback({error:'Paricipant not found'});
    }
    
  });

  // Individual Mute
  socket.on('muteParticipant',({roomName,userId,targetUserId,mute},callback) =>{
    if (roomModerators[roomName] !== userId) {
      return callback({ error: 'Only moderator can control participant audio' });
    }
    
    const room = rooms[roomName];
    if (!room) return callback({ error: 'Room not found' });

    // Find and mute/unmute target participant
    for (const [socketId, peer] of room.peers.entries()) {
      if (peer.userId === targetUserId) {
        peer.socket.emit(mute ? 'forceAudioMute' : 'forceAudioUnmute');
        peer.isMuted = mute;
        callback({ success: true, message: `${targetUserId} ${mute ? 'muted' : 'unmuted'}` });
        return;
      }
    }
    
    callback({ error: 'Participant not found' });
  
  });

  // Pause/Resume screen share
  socket.on('pauseScreenShare', ({ producerId, pause }, callback) => {
    const room = rooms[socket.roomName];
    if (!room) return callback({ error: 'Room not found' });
    
    const peer = room.peers.get(socket.id);
    if (!peer) return callback({ error: 'Peer not found' });
    
    const producer = peer.producers?.find(p => p.id === producerId);
    if (!producer) return callback({ error: 'Producer not found' });
    
    if (pause) {
      producer.pause();
    } else {
      producer.resume();
    }
    
    // Notify other participants
    room.peers.forEach((otherPeer, otherSocketId) => {
      if (otherSocketId !== socket.id) {
        otherPeer.socket.emit('screenSharePaused', { 
          producerId, 
          userId: peer.userId, 
          paused: pause 
        });
      }
    });
    
    callback({ success: true, paused: pause });
  });

  // Set stream quality
  socket.on('setStreamQuality', ({ quality }, callback) => {
    // quality: 'low', 'medium', 'high'
    const qualitySettings = {
      low: { width: 320, height: 240, frameRate: 15 },
      medium: { width: 640, height: 480, frameRate: 24 },
      high: { width: 1280, height: 720, frameRate: 30 }
    };
    
    const settings = qualitySettings[quality] || qualitySettings.medium;
    
    // This would typically be handled on the client side
    // Send back the quality settings for client to apply
    callback({ success: true, settings });
  });

});

server.listen(3000, () => {
  console.log('Mediasoup server running at http://localhost:3000');
});
