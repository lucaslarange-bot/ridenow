/**
 * RideNow - Backend (Express + Socket.io)
 * Prototype type Uber : chauffeurs live, demande de course, chat temps reel, estimation prix.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, '..', 'web'))); // sert le front en local (Railway peut aussi servir)
app.get('/api/health', (_req, res) => res.json({ ok: true, drivers: drivers.size, rides: rides.size }));

// ---------------------------------------------------------------------------
// Etat en memoire (prototype). Pour la prod : remplacer par Postgres/Redis.
// ---------------------------------------------------------------------------
const drivers = new Map(); // socketId -> { id, name, car, plate, lat, lng, online, rideId, bot }
const clients = new Map(); // socketId -> { id, name, lat, lng, rideId }
const rides = new Map();   // rideId -> ride object

let rideSeq = 1;

// ---- Tarification -----------------------------------------------------------
const PRICING = { base: 2.5, perKm: 1.2, perMin: 0.35, minFare: 6, avgSpeedKmh: 28 };

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function estimate(pickup, dropoff) {
  const km = haversineKm(pickup, dropoff);
  const min = (km / PRICING.avgSpeedKmh) * 60;
  const price = Math.max(PRICING.minFare, PRICING.base + km * PRICING.perKm + min * PRICING.perMin);
  return { km: +km.toFixed(2), min: Math.max(1, Math.round(min)), price: +price.toFixed(2) };
}

// ---- Diffusion des positions chauffeurs ------------------------------------
function publicDrivers() {
  return [...drivers.values()]
    .filter((d) => d.online)
    .map((d) => ({ id: d.id, name: d.name, car: d.car, plate: d.plate, lat: d.lat, lng: d.lng, busy: !!d.rideId }));
}
function broadcastDrivers() {
  io.emit('drivers:update', publicDrivers());
}

// ---- Bots : quelques chauffeurs simules qui roulent dans Paris -------------
const CITY = { lat: 48.8566, lng: 2.3522 }; // Paris centre
function spawnBots(n = 5) {
  const cars = ['Tesla Model 3', 'Renault Zoe', 'Peugeot 508', 'Mercedes Classe E', 'Toyota Prius'];
  for (let i = 0; i < n; i++) {
    const id = 'bot-' + (i + 1);
    drivers.set(id, {
      id,
      name: ['Karim', 'Sophie', 'Marco', 'Ines', 'David', 'Lea'][i % 6],
      car: cars[i % cars.length],
      plate: 'BOT-' + (100 + i),
      lat: CITY.lat + (Math.random() - 0.5) * 0.04,
      lng: CITY.lng + (Math.random() - 0.5) * 0.06,
      online: true,
      rideId: null,
      bot: true,
      heading: Math.random() * Math.PI * 2,
    });
  }
}
function moveBots() {
  let moved = false;
  for (const d of drivers.values()) {
    if (!d.bot || d.rideId) continue;
    moved = true;
    d.heading += (Math.random() - 0.5) * 0.6;
    const step = 0.0006;
    d.lat += Math.cos(d.heading) * step;
    d.lng += Math.sin(d.heading) * step;
    // rester dans une zone raisonnable
    if (haversineKm(d, CITY) > 5) d.heading += Math.PI;
  }
  if (moved) broadcastDrivers();
}
spawnBots();
setInterval(moveBots, 1500);

// Un bot accepte une course en attente au bout de qq secondes (demo fluide)
function maybeBotAccept(ride) {
  setTimeout(() => {
    const r = rides.get(ride.id);
    if (!r || r.status !== 'requested') return;
    const bot = [...drivers.values()].find((d) => d.bot && d.online && !d.rideId);
    if (!bot) return;
    assignRide(r, bot, null);
  }, 4000 + Math.random() * 3000);
}

// ---- Assignation d'une course a un chauffeur -------------------------------
function assignRide(ride, driver, driverSocket) {
  ride.status = 'accepted';
  ride.driver = { id: driver.id, name: driver.name, car: driver.car, plate: driver.plate };
  driver.rideId = ride.id;
  ride.driverSocketId = driverSocket ? driverSocket.id : null;

  io.to(ride.clientSocketId).emit('ride:accepted', ride);
  if (ride.driverSocketId) io.to(ride.driverSocketId).emit('ride:accepted', ride);
  io.emit('ride:taken', { rideId: ride.id }); // retirer de la file des autres chauffeurs
  broadcastDrivers();

  if (driver.bot) simulateBotRide(ride, driver);
}

// Simulation d'un chauffeur bot qui vient chercher puis depose le client
function simulateBotRide(ride, driver) {
  const legTo = (target, nextStatus, done) => {
    const iv = setInterval(() => {
      const r = rides.get(ride.id);
      if (!r || r.status === 'cancelled') return clearInterval(iv);
      const dx = target.lat - driver.lat;
      const dy = target.lng - driver.lng;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.0008) {
        clearInterval(iv);
        r.status = nextStatus;
        io.to(r.clientSocketId).emit('ride:status', { rideId: r.id, status: nextStatus, ride: r });
        done && done();
        return;
      }
      driver.lat += (dx / dist) * 0.0012;
      driver.lng += (dy / dist) * 0.0012;
      io.to(r.clientSocketId).emit('driver:position', { rideId: r.id, lat: driver.lat, lng: driver.lng });
      broadcastDrivers();
    }, 700);
  };
  legTo(ride.pickup, 'arrived', () => {
    setTimeout(() => {
      const r = rides.get(ride.id);
      if (!r) return;
      r.status = 'in_progress';
      io.to(r.clientSocketId).emit('ride:status', { rideId: r.id, status: 'in_progress', ride: r });
      legTo(ride.dropoff, 'completed', () => {
        driver.rideId = null;
        broadcastDrivers();
      });
    }, 2500);
  });
  // petit message de bienvenue du bot
  setTimeout(() => {
    const r = rides.get(ride.id);
    if (!r || r.status === 'cancelled') return;
    const msg = { from: 'driver', name: driver.name, text: "Bonjour ! J'arrive vers vous 🚗", ts: Date.now() };
    r.messages.push(msg);
    io.to(r.clientSocketId).emit('chat:message', { rideId: r.id, message: msg });
  }, 2000);
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.emit('drivers:update', publicDrivers());

  // Inscription (role client ou chauffeur)
  socket.on('register', ({ role, name, lat, lng, car, plate }) => {
    socket.data.role = role;
    if (role === 'driver') {
      drivers.set(socket.id, {
        id: socket.id, name: name || 'Chauffeur', car: car || 'Berline', plate: plate || 'AA-000-AA',
        lat: lat ?? CITY.lat, lng: lng ?? CITY.lng, online: false, rideId: null, bot: false,
      });
    } else {
      clients.set(socket.id, { id: socket.id, name: name || 'Client', lat, lng, rideId: null });
    }
    socket.emit('registered', { id: socket.id, role });
  });

  // Chauffeur : online/offline
  socket.on('driver:online', ({ online }) => {
    const d = drivers.get(socket.id);
    if (!d) return;
    d.online = online;
    broadcastDrivers();
    if (online) {
      // envoyer les courses en attente au chauffeur qui se connecte
      const pending = [...rides.values()].filter((r) => r.status === 'requested');
      pending.forEach((r) => socket.emit('ride:request', r));
    }
  });

  // Chauffeur : mise a jour position
  socket.on('driver:location', ({ lat, lng }) => {
    const d = drivers.get(socket.id);
    if (!d) return;
    d.lat = lat; d.lng = lng;
    if (d.rideId) {
      const r = rides.get(d.rideId);
      if (r) io.to(r.clientSocketId).emit('driver:position', { rideId: r.id, lat, lng });
    }
    broadcastDrivers();
  });

  // Client : demande de course
  socket.on('ride:request', ({ pickup, dropoff, name }) => {
    const est = estimate(pickup, dropoff);
    const ride = {
      id: 'R' + rideSeq++,
      clientSocketId: socket.id,
      clientName: name || 'Client',
      pickup, dropoff,
      estimate: est,
      status: 'requested',
      driver: null,
      driverSocketId: null,
      messages: [],
      createdAt: Date.now(),
    };
    rides.set(ride.id, ride);
    const c = clients.get(socket.id);
    if (c) c.rideId = ride.id;
    socket.emit('ride:created', ride);
    // notifier les chauffeurs humains en ligne
    for (const [sid, d] of drivers) {
      if (!d.bot && d.online && !d.rideId) io.to(sid).emit('ride:request', ride);
    }
    // fallback : un bot finit par accepter
    maybeBotAccept(ride);
  });

  // Chauffeur : accepte une course
  socket.on('ride:accept', ({ rideId }) => {
    const ride = rides.get(rideId);
    const d = drivers.get(socket.id);
    if (!ride || !d) return;
    if (ride.status !== 'requested') { socket.emit('ride:error', { msg: 'Course deja prise' }); return; }
    assignRide(ride, d, socket);
  });

  // Chauffeur : change le statut du trajet
  socket.on('ride:status', ({ rideId, status }) => {
    const ride = rides.get(rideId);
    if (!ride) return;
    ride.status = status;
    io.to(ride.clientSocketId).emit('ride:status', { rideId, status, ride });
    if (ride.driverSocketId) io.to(ride.driverSocketId).emit('ride:status', { rideId, status, ride });
    if (status === 'completed') {
      const d = drivers.get(socket.id);
      if (d) d.rideId = null;
      broadcastDrivers();
    }
  });

  // Annulation
  socket.on('ride:cancel', ({ rideId }) => {
    const ride = rides.get(rideId);
    if (!ride) return;
    ride.status = 'cancelled';
    io.to(ride.clientSocketId).emit('ride:status', { rideId, status: 'cancelled', ride });
    if (ride.driverSocketId) io.to(ride.driverSocketId).emit('ride:status', { rideId, status: 'cancelled', ride });
    const d = [...drivers.values()].find((x) => x.rideId === rideId);
    if (d) d.rideId = null;
    broadcastDrivers();
  });

  // Chat bidirectionnel
  socket.on('chat:message', ({ rideId, text, from, name }) => {
    const ride = rides.get(rideId);
    if (!ride || !text) return;
    const message = { from, name: name || from, text: String(text).slice(0, 500), ts: Date.now() };
    ride.messages.push(message);
    io.to(ride.clientSocketId).emit('chat:message', { rideId, message });
    if (ride.driverSocketId) io.to(ride.driverSocketId).emit('chat:message', { rideId, message });
  });

  // Estimation a la volee (sans creer de course)
  socket.on('estimate', ({ pickup, dropoff }, cb) => {
    if (typeof cb === 'function') cb(estimate(pickup, dropoff));
  });

  socket.on('disconnect', () => {
    drivers.delete(socket.id);
    clients.delete(socket.id);
    broadcastDrivers();
  });
});

server.listen(PORT, () => console.log(`RideNow -> http://localhost:${PORT}`));
