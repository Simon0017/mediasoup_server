const mediasoup = require('mediasoup');
const { Server } = require('socket.io');
const http = require('http');
const { start } = require('repl');

// importing libraries for the recording logic plus the recording logic
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { exec } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const recordingDir = path.join(__dirname,'recordings');
if (!fs.existsSync(recordingDir)){
  fs.mkdirSync(recordingDir);
}

const activeRecordings = {}; // roomName -> recording session
const mainVideoStreams = {}; // roomName -> { userId, producerId }
const recordingConsumers = {}; // roomName -> consumer instance

const rooms = {}; // roomName -> { peers: Map<socketId, peerData> }
const roomModerators = {};

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

  // Handler for checking if the room exists
  socket.on('checkStatus', ({ roomName }, callback) => {
    if (rooms[roomName]) {
      callback({ exists: true });
    } else {
      callback({ exists: false });
    }
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
      
      // set main video when moderator produces video
      if (kind === 'video' && peer.userId === roomModerators[socket.roomName]) {
        if (!mainVideoStreams[socket.roomName]) {
          mainVideoStreams[socket.roomName] = {
            userId: peer.userId,
            producerId: producer.id
          };
          notifyMainVideoChange(socket.roomName);
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

  // Start/Stop the meeting recording   
  socket.on('toggleRecording',async ({roomName,userId},callback) =>{     
    try {       
      if (roomModerators[roomName] !== userId){         
        return callback({error: "Only Moderators can control the recording"});       
      }        

      const room = rooms[roomName];       
      if (!room) {         
        return callback({ error: "Room not found" });       
      }        

      // start the recording       
      if (!activeRecordings[roomName]){         
        // check the main video         
        const mainVideo = mainVideoStreams[roomName];         
        if (!mainVideo){           
          console.log("No Main Video set");           
          return callback({error:"No main video stream set"});         
        }                  
        
        // find the main video Producer         
        let mainVideoProducer = null;         
        for (const peer of room.peers.values()) {           
          if (peer.userId === mainVideo.userId) {             
            mainVideoProducer = peer.producers.find(p => p.id === mainVideo.producerId);             
            if (mainVideoProducer) break;           
          }         
        }          

        if(!mainVideoProducer){           
          console.log('Main video stream not available');           
          return callback({error:"Main video stream not available"});         
        }          

        // Debug producer status
        console.log('=== PRODUCER DEBUG ===');
        console.log('Producer ID:', mainVideoProducer.id);
        console.log('Producer kind:', mainVideoProducer.kind);
        console.log('Producer paused:', mainVideoProducer.paused);
        console.log('Producer closed:', mainVideoProducer.closed);
        
        const producerStats = await mainVideoProducer.getStats();
        console.log('Producer stats:', producerStats);

        const recordingId = `recording-${roomName}-${Date.now()}`;         
        const filename = path.join(recordingDir, `${recordingId}.webm`);         
        console.log(`Recording Details:ID> ${recordingId}, filename> ${filename}`);
        
        // Debug file path and permissions
        console.log('Recording directory:', recordingDir);
        console.log('Directory exists:', fs.existsSync(recordingDir));
        console.log('Full filename path:', filename);
                  
        // create a plainRTpTransport 
        const transport = await router.createPlainTransport({
          listenIp: { ip: '127.0.0.1' },
          rtcpMux: false,
          comedia: false
        });

        console.log("============TRANSPORT DEBUG============");
        console.log('PlainRtpTransport created:', transport.tuple);

        const { localIp, localPort } = transport.tuple;
        console.log('PlainRtpTransport IP:', localIp, 'Port:', localPort);
        const ffmpegPort = 5004;

        
        // Set up FFmpeg process for RTP stream - Fixed format
        const ffmpeg = spawn(ffmpegPath, [
          '-protocol_whitelist', 'file,udp,rtp',
          '-f', 'rtp',
          '-i', `rtp://127.0.0.1:${ffmpegPort}`,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          filename
        ]);
        
        await transport.connect({
          ip: '127.0.0.1',
          port: ffmpegPort,
          rtcpPort: ffmpegPort
        });
        console.log('Transport connected to local IP:', localIp, 'Port:', localPort);
        console.log('Transport connected to FFmpeg RTP stream');

        // create a consumer for the mainvideo         
        const consumer = await transport.consume({           
          producerId: mainVideoProducer.id,           
          rtpCapabilities: router.rtpCapabilities,           
          paused: false  ,
          // preferredLayers: { spatial: 2, temporal: 2 } // Add preferred layers       
        });

        // Debug consumer creation
        console.log('=== CONSUMER DEBUG ===');
        console.log('Consumer created successfully');
        console.log('Consumer ID:', consumer.id);
        console.log('Consumer closed:', consumer.closed);
        console.log('Consumer paused:', consumer.paused);
        console.log('Consumer producer paused:', consumer.producerPaused);
        console.log('Consumer kind:', consumer.kind);
        console.log('Consumer type:', consumer.type);

        // Resume consumer if paused
        if (consumer.paused) {
          await consumer.resume();
          console.log('Consumer resumed');
        }

        // Add FFmpeg error handling
        ffmpeg.on('error', (error) => {
          console.error('FFmpeg process error:', error);
        });

        ffmpeg.stderr.on('data', (data) => {
          console.log('FFmpeg stderr:', data.toString());
        });

        ffmpeg.on('exit', (code) => {
          console.log('FFmpeg process exited with code:', code);
        });

        console.log('FFmpeg process started with PID:', ffmpeg.pid);

        // Enhanced RTP packet handling with debugging
        let rtpPacketCount = 0;
        consumer.on('rtp', (rtpPacket) => {
          rtpPacketCount++;
          if (rtpPacketCount === 1) {
            console.log('First RTP packet received!');
          }
          if (rtpPacketCount % 100 === 0) {
            console.log(`RTP packets received: ${rtpPacketCount}`);
          }
          
          try {
            ffmpeg.stdin.write(rtpPacket.payload);
          } catch (error) {
            console.error('Error writing to FFmpeg:', error);
          }
        });

        // Add consumer event handlers for debugging
        consumer.on('transportclose', () => {
          console.log('Consumer transport closed');
        });

        consumer.on('producerclose', () => {
          console.log('Consumer producer closed');
        });

        consumer.on('producerpause', () => {
          console.log('Consumer producer paused');
        });

        consumer.on('producerresume', () => {
          console.log('Consumer producer resumed');
        });

        // Check consumer stats periodically for debugging - Fixed to avoid circular reference
        const statsInterval = setInterval(async () => {
          try {
            const stats = await consumer.getStats();
            console.log('Consumer stats available:', stats.length, 'entries');
            // Look for RTP stats without causing circular reference
            for (const stat of stats) {
              if (stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp') {
                console.log(`${stat.type} - Packets: ${stat.packetsReceived || stat.packetsSent || 0}, Bytes: ${stat.bytesReceived || stat.bytesSent || 0}`);
              }
            }
          } catch (error) {
            console.error('Error getting consumer stats:', error);
          }
        }, 5000);

        // Store the recording with clean object to avoid circular reference
        activeRecordings[roomName] = {           
          id: recordingId,           
          startTime: new Date(),           
          filename,           
          process: ffmpeg,           
          consumer: {
            id: consumer.id,
            closed: consumer.closed,
            paused: consumer.paused
          }, // Store only essential consumer properties
          statsInterval // Store interval to clear it later
        };          

        recordingConsumers[roomName] = consumer;          

        // Notify all the users/participant in the room         
        room.peers.forEach(peer => {           
          peer.socket.emit('recordingStarted', {             
            recordingId,             
            startTime: activeRecordings[roomName].startTime,             
            mainVideoUserId: mainVideo.userId,           
          });         
        });                   

        console.log("Recording started...");
        console.log("If you don't see RTP packets, check producer activity and transport setup");
        
        // Return clean response without circular references
        return callback({
          success: true,
          recording: {
            id: recordingId,
            startTime: activeRecordings[roomName].startTime,
            filename: filename
          }
        });       
      }else{         
        // Stop the recording         
        const recording = activeRecordings[roomName];                  

        // Clear the stats interval
        if (recording.statsInterval) {
          clearInterval(recording.statsInterval);
        }

        // close the consumer and process         
        recordingConsumers[roomName].close();         
        recording.process.stdin.end();          

        await new Promise(resolve => {           
          recording.process.on('exit', resolve);         
        });          

        const duration = Date.now() - recording.startTime.getTime();         
        delete activeRecordings[roomName];         
        delete recordingConsumers[roomName];          

        // Notify participants          
        room.peers.forEach(peer => {           
          peer.socket.emit('recordingStopped',{             
            recordingId: recording.id,             
            duration,             
            mainVideoUserId: mainVideoStreams[roomName]?.userId,           
          });         
        });          

        console.log("Recording stopped. Duration:", duration, "ms");
        console.log("Check file:", recording.filename);

        return callback({           
          success:true,           
          stopped:true,           
          recordingId:recording.id,           
          duration,         
        });        
      }     
    } catch (error) {       
      console.error('Recording error:', error);       
      callback({ error: "Recording failed: " + error.message });     
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

  // set the main video
  socket.on('setMainVideo',({roomName,userId,targetUserId},callback)=>{
    try {
      // Verify moderator privileges ******************REINTRODUCE THIS ROOM MOD CONTROL LATER************ 
      // if (roomModerators[roomName] !== userId) {
      //   return callback({ error: "Only moderators can set main video" });
      // }

      const room = rooms[roomName];
      if (!room) return callback({ error: "Room not found" });
      console.log(`Target User: ${targetUserId}`);
      

      // Find target user's video producer
      let videoProducer = null;
      for (const [_, peer] of room.peers) {
        if (peer.userId === targetUserId) {
          videoProducer = peer.producers.find(p => p.kind === 'video');
          if (videoProducer) break;
        }
      }

      if (!videoProducer) {
        return callback({ error: "Target user has no video stream" });
      }

      // Update main video
      mainVideoStreams[roomName] = {
        userId: targetUserId,
        producerId: videoProducer.id
      };

      // Notify all participants
      room.peers.forEach(peer => {
        peer.socket.emit('mainVideoChanged', {
          userId: targetUserId,
          producerId: videoProducer.id,
          isInitial:false
        });
      });

      callback({ success: true });
    } catch (err) {
      console.error('Error setting main video:', err);
      callback({ error: "Failed to set main video" });
    }
  });

});

// function to notify the main video
function notifyMainVideoChange(roomName) {
  const room = rooms[roomName];
  if (!room || !mainVideoStreams[roomName]) return;

  const mainVideo = mainVideoStreams[roomName];
  room.peers.forEach(peer => {
    peer.socket.emit('mainVideoChanged', {
      userId: mainVideo.userId,
      producerId: mainVideo.producerId,
      isInitial: false
    });
  });
}

// function to set the main defauif video
async function setDefaultMainVideo(roomName) {
  const room = rooms[roomName];
  if (!room || mainVideoStreams[roomName]) return;

  const moderatorId = roomModerators[roomName];
  console.log(`Attempting to set default main video for room ${roomName}, moderator: ${moderatorId}`);

  // Wait for moderator to produce video (with timeout)
  let attempts = 0;
  const maxAttempts = 10;
  const checkInterval = 1000; // 1 second

  const checkForVideo = setInterval(() => {
    attempts++;
    const moderatorPeer = [...room.peers.values()].find(p => p.userId === moderatorId);
    
    if (moderatorPeer) {
      const videoProducer = moderatorPeer.producers.find(p => p.kind === 'video');
      
      if (videoProducer) {
        clearInterval(checkForVideo);
        mainVideoStreams[roomName] = {
          userId: moderatorId,
          producerId: videoProducer.id
        };
        console.log(`Set default main video to moderator ${moderatorId}'s stream`);
        notifyMainVideoChange(roomName);
      } else if (attempts >= maxAttempts) {
        clearInterval(checkForVideo);
        console.log(`Moderator ${moderatorId} has no video after ${maxAttempts} attempts`);
      }
    } else if (attempts >= maxAttempts) {
      clearInterval(checkForVideo);
      console.log(`Moderator peer not found after ${maxAttempts} attempts`);
    }
  }, checkInterval);
}

server.listen(3000, () => {
  console.log('Mediasoup server running at http://localhost:3000');
});
