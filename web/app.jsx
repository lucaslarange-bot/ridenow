const { useState, useEffect, useRef, useCallback } = React;

const CITY = { lat: 48.8566, lng: 2.3522 };
const BACKEND = (window.RIDENOW_BACKEND || '').trim();
const socket = BACKEND ? io(BACKEND, { transports: ['websocket', 'polling'] }) : io();

// ---- Icones Leaflet (divIcon => pas d'images externes) ---------------------
const carIcon = (busy) =>
  L.divIcon({
    className: '',
    html: `<div style="font-size:26px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));${busy ? 'opacity:.45' : ''}">🚗</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
const pinIcon = (emoji, color) =>
  L.divIcon({
    className: '',
    html: `<div style="display:flex;flex-direction:column;align-items:center">
      <div style="background:${color};width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5)">
        <div style="transform:rotate(45deg);text-align:center;line-height:26px;font-size:14px">${emoji}</div>
      </div></div>`,
    iconSize: [30, 42], iconAnchor: [15, 40],
  });

function fmtPrice(p) { return p == null ? '—' : p.toFixed(2).replace('.', ',') + ' €'; }

// ===========================================================================
function App() {
  const [role, setRole] = useState(null); // 'client' | 'driver'
  const [name, setName] = useState('');
  const [myPos, setMyPos] = useState(null);

  const mapRef = useRef(null);
  const map = useRef(null);
  const layers = useRef({ drivers: {}, pickup: null, dropoff: null, route: null, me: null });

  // ---- Init carte quand le role est choisi --------------------------------
  useEffect(() => {
    if (!role || map.current) return;
    map.current = L.map(mapRef.current, { zoomControl: false, attributionControl: false }).setView(
      [myPos?.lat || CITY.lat, myPos?.lng || CITY.lng], 14
    );
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map.current);
    L.control.zoom({ position: 'topright' }).addTo(map.current);
  }, [role]);

  // ---- Geolocalisation ----------------------------------------------------
  useEffect(() => {
    if (!navigator.geolocation) { setMyPos(CITY); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setMyPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setMyPos(CITY),
      { timeout: 5000 }
    );
    // fallback si pas de reponse
    const t = setTimeout(() => setMyPos((v) => v || CITY), 5500);
    return () => clearTimeout(t);
  }, []);

  const start = (r) => {
    if (!myPos) setMyPos(CITY);
    setRole(r);
    socket.emit('register', {
      role: r, name: name || (r === 'driver' ? 'Chauffeur' : 'Client'),
      lat: (myPos || CITY).lat, lng: (myPos || CITY).lng,
      car: 'Tesla Model 3', plate: 'GO-2026',
    });
  };

  if (!role) return <Landing name={name} setName={setName} start={start} />;

  return (
    <div className="app">
      <div id="map" ref={mapRef}></div>
      {role === 'client'
        ? <ClientView map={map} layers={layers} myPos={myPos || CITY} name={name || 'Client'} />
        : <DriverView map={map} layers={layers} myPos={myPos || CITY} name={name || 'Chauffeur'} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Landing({ name, setName, start }) {
  return (
    <div className="landing">
      <div className="logo">Ride<span>Now</span></div>
      <div className="tag">Le trajet, en un tap.</div>
      <div className="field" style={{ maxWidth: 320 }}>
        <input placeholder="Ton prénom" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="roles">
        <div className="role-card">
          <div className="ico">🧍</div>
          <h3>Je suis client</h3>
          <p>Commande une course, suis ton chauffeur en direct et discute avec lui.</p>
          <button onClick={() => start('client')}>Commander une course</button>
        </div>
        <div className="role-card driver">
          <div className="ico">🚗</div>
          <h3>Je suis chauffeur</h3>
          <p>Passe en ligne, reçois des demandes autour de toi et accepte tes courses.</p>
          <button onClick={() => start('driver')}>Conduire</button>
        </div>
      </div>
      <div className="muted" style={{ maxWidth: 340, textAlign: 'center' }}>
        Astuce : ouvre l'app dans deux onglets (un client + un chauffeur) pour tester le temps réel.
      </div>
    </div>
  );
}

// ===========================================================================
// Hook partagé : suit les chauffeurs live sur la carte
function useDriverMarkers(map, layers) {
  useEffect(() => {
    const onDrivers = (list) => {
      if (!map.current) return;
      const seen = {};
      list.forEach((d) => {
        seen[d.id] = true;
        const m = layers.current.drivers[d.id];
        if (m) { m.setLatLng([d.lat, d.lng]); m.setIcon(carIcon(d.busy)); }
        else layers.current.drivers[d.id] = L.marker([d.lat, d.lng], { icon: carIcon(d.busy) }).addTo(map.current);
      });
      Object.keys(layers.current.drivers).forEach((id) => {
        if (!seen[id]) { map.current.removeLayer(layers.current.drivers[id]); delete layers.current.drivers[id]; }
      });
    };
    socket.on('drivers:update', onDrivers);
    return () => socket.off('drivers:update', onDrivers);
  }, []);
}

// ===========================================================================
function ClientView({ map, layers, myPos, name }) {
  const [pickup, setPickup] = useState(myPos);
  const [dropoff, setDropoff] = useState(null);
  const [est, setEst] = useState(null);
  const [ride, setRide] = useState(null);
  const [status, setStatus] = useState('idle'); // idle|requested|accepted|arrived|in_progress|completed|cancelled
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [unread, setUnread] = useState(0);

  useDriverMarkers(map, layers);

  // Marqueur pickup (draggable) + gestion clic pour destination
  useEffect(() => {
    if (!map.current) return;
    layers.current.pickup = L.marker([pickup.lat, pickup.lng], { icon: pinIcon('🟢', '#00d18f'), draggable: true })
      .addTo(map.current).bindTooltip('Départ');
    layers.current.pickup.on('dragend', (e) => {
      const ll = e.target.getLatLng(); setPickup({ lat: ll.lat, lng: ll.lng });
    });
    const onClick = (e) => {
      if (statusRef.current !== 'idle') return;
      setDropoff({ lat: e.latlng.lat, lng: e.latlng.lng });
    };
    map.current.on('click', onClick);
    map.current.setView([pickup.lat, pickup.lng], 14);
    return () => { map.current && map.current.off('click', onClick); };
  }, [map.current]);

  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Marqueur destination + route + estimation
  useEffect(() => {
    if (!map.current) return;
    if (layers.current.dropoff) { map.current.removeLayer(layers.current.dropoff); layers.current.dropoff = null; }
    if (layers.current.route) { map.current.removeLayer(layers.current.route); layers.current.route = null; }
    if (!dropoff) { setEst(null); return; }
    layers.current.dropoff = L.marker([dropoff.lat, dropoff.lng], { icon: pinIcon('🏁', '#0a84ff') })
      .addTo(map.current).bindTooltip('Arrivée');
    layers.current.route = L.polyline([[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]],
      { color: '#0a84ff', weight: 4, opacity: .7, dashArray: '8 8' }).addTo(map.current);
    map.current.fitBounds(layers.current.route.getBounds(), { padding: [70, 70] });
    socket.emit('estimate', { pickup, dropoff }, (e) => setEst(e));
  }, [dropoff, pickup]);

  // Ecoute des évènements course/chat
  useEffect(() => {
    const onCreated = (r) => { setRide(r); setStatus('requested'); };
    const onAccepted = (r) => {
      setRide(r); setStatus('accepted'); setMessages(r.messages || []);
      if (layers.current.route) map.current.removeLayer(layers.current.route);
    };
    const onPos = ({ lat, lng }) => {
      if (!map.current) return;
      if (layers.current.driverLive) layers.current.driverLive.setLatLng([lat, lng]);
      else layers.current.driverLive = L.marker([lat, lng], { icon: carIcon(false) }).addTo(map.current);
    };
    const onStatus = ({ status: s, ride: r }) => {
      setStatus(s); if (r) setRide(r);
      if (s === 'completed' && layers.current.driverLive) {
        map.current.removeLayer(layers.current.driverLive); layers.current.driverLive = null;
      }
    };
    const onMsg = ({ message }) => {
      setMessages((m) => [...m, message]);
      if (message.from !== 'client') setUnread((u) => (chatRef.current ? 0 : u + 1));
    };
    socket.on('ride:created', onCreated);
    socket.on('ride:accepted', onAccepted);
    socket.on('driver:position', onPos);
    socket.on('ride:status', onStatus);
    socket.on('chat:message', onMsg);
    return () => {
      socket.off('ride:created', onCreated); socket.off('ride:accepted', onAccepted);
      socket.off('driver:position', onPos); socket.off('ride:status', onStatus); socket.off('chat:message', onMsg);
    };
  }, []);

  const chatRef = useRef(false);
  useEffect(() => { chatRef.current = chatOpen; if (chatOpen) setUnread(0); }, [chatOpen]);

  const request = () => socket.emit('ride:request', { pickup, dropoff, name });
  const cancel = () => { if (ride) socket.emit('ride:cancel', { rideId: ride.id }); };
  const sendMsg = (text) => socket.emit('chat:message', { rideId: ride.id, text, from: 'client', name });
  const reset = () => {
    setDropoff(null); setEst(null); setRide(null); setStatus('idle'); setMessages([]); setChatOpen(false);
  };

  const showChat = ['accepted', 'arrived', 'in_progress'].includes(status);

  return (
    <React.Fragment>
      <div className="topbar"><button onClick={() => location.reload()}>← Rôle</button></div>
      {status === 'idle' && !dropoff &&
        <div className="hint">📍 Touche la carte pour poser ta destination</div>}

      {showChat &&
        <button className="chat-toggle" onClick={() => setChatOpen(true)}>💬
          {unread > 0 && <span className="chat-badge">{unread}</span>}</button>}

      {chatOpen &&
        <Chat title={ride?.driver?.name || 'Chauffeur'} sub={ride?.driver?.car}
          messages={messages} me="client" onSend={sendMsg} onClose={() => setChatOpen(false)} />}

      <div className="sheet">
        <div className="grab"></div>
        {status === 'idle' && (
          <React.Fragment>
            <div className="title">Où va-t-on, {name} ?</div>
            {!dropoff
              ? <div className="muted">Fais glisser le point vert (départ) puis touche la carte pour choisir l'arrivée.</div>
              : <React.Fragment>
                  <div className="est">
                    <div className="box"><small>Prix estimé</small><b>{fmtPrice(est?.price)}</b></div>
                    <div className="box"><small>Distance</small><b>{est ? est.km + ' km' : '—'}</b></div>
                    <div className="box"><small>Durée</small><b>{est ? est.min + ' min' : '—'}</b></div>
                  </div>
                  <button className="btn-primary" onClick={request}>Commander · {fmtPrice(est?.price)}</button>
                  <button className="btn-ghost" onClick={() => setDropoff(null)}>Changer la destination</button>
                </React.Fragment>}
          </React.Fragment>
        )}

        {status === 'requested' && (
          <React.Fragment>
            <div className="title pulse"><span className="spin"></span>Recherche d'un chauffeur…</div>
            <div className="muted">On prévient les chauffeurs disponibles autour de toi.</div>
            <button className="btn-danger" onClick={cancel}>Annuler</button>
          </React.Fragment>
        )}

        {['accepted', 'arrived', 'in_progress'].includes(status) && ride?.driver && (
          <React.Fragment>
            <div className="status-pill">
              {status === 'accepted' && 'Ton chauffeur arrive'}
              {status === 'arrived' && 'Chauffeur sur place 📍'}
              {status === 'in_progress' && 'En route vers ta destination'}
            </div>
            <div className="driver-info">
              <div className="avatar">{ride.driver.name[0]}</div>
              <div style={{ flex: 1 }}>
                <div className="title">{ride.driver.name}</div>
                <div className="muted">{ride.driver.car} · {ride.driver.plate}</div>
              </div>
              <button className="btn-blue" style={{ width: 'auto', padding: '10px 14px' }}
                onClick={() => setChatOpen(true)}>💬</button>
            </div>
            <div className="est">
              <div className="box"><small>Prix</small><b>{fmtPrice(ride.estimate.price)}</b></div>
              <div className="box"><small>Distance</small><b>{ride.estimate.km} km</b></div>
              <div className="box"><small>Durée</small><b>{ride.estimate.min} min</b></div>
            </div>
            {status !== 'in_progress' && <button className="btn-danger" onClick={cancel}>Annuler la course</button>}
          </React.Fragment>
        )}

        {status === 'completed' && (
          <React.Fragment>
            <div className="status-pill">Course terminée ✅</div>
            <div className="title">Merci {name} !</div>
            <div className="est">
              <div className="box"><small>Total payé</small><b>{fmtPrice(ride?.estimate.price)}</b></div>
              <div className="box"><small>Distance</small><b>{ride?.estimate.km} km</b></div>
            </div>
            <button className="btn-primary" onClick={reset}>Nouvelle course</button>
          </React.Fragment>
        )}

        {status === 'cancelled' && (
          <React.Fragment>
            <div className="status-pill" style={{ background: '#2a1416', color: '#ff4d5e' }}>Course annulée</div>
            <button className="btn-primary" onClick={reset}>Nouvelle course</button>
          </React.Fragment>
        )}
      </div>
    </React.Fragment>
  );
}

// ===========================================================================
function DriverView({ map, layers, myPos, name }) {
  const [online, setOnline] = useState(false);
  const [pos, setPos] = useState(myPos);
  const [requests, setRequests] = useState([]);
  const [ride, setRide] = useState(null);
  const [status, setStatus] = useState('idle');
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [unread, setUnread] = useState(0);

  useDriverMarkers(map, layers);
  const chatRef = useRef(false);
  useEffect(() => { chatRef.current = chatOpen; if (chatOpen) setUnread(0); }, [chatOpen]);

  // Marqueur "moi" (chauffeur) + déplacement au clic sur la carte
  useEffect(() => {
    if (!map.current) return;
    layers.current.me = L.marker([pos.lat, pos.lng], { icon: pinIcon('🚕', '#ffb020') })
      .addTo(map.current).bindTooltip('Toi');
    const onClick = (e) => {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      setPos(p); layers.current.me.setLatLng([p.lat, p.lng]);
      socket.emit('driver:location', p);
    };
    map.current.on('click', onClick);
    map.current.setView([pos.lat, pos.lng], 14);
    return () => { map.current && map.current.off('click', onClick); };
  }, [map.current]);

  // Evènements
  useEffect(() => {
    const onReq = (r) => setRequests((list) => list.find((x) => x.id === r.id) ? list : [...list, r]);
    const onTaken = ({ rideId }) => setRequests((list) => list.filter((x) => x.id !== rideId));
    const onAccepted = (r) => {
      setRide(r); setStatus('accepted'); setMessages(r.messages || []);
      setRequests([]);
      if (!map.current) return;
      layers.current.cPickup = L.marker([r.pickup.lat, r.pickup.lng], { icon: pinIcon('🟢', '#00d18f') }).addTo(map.current).bindTooltip('Client');
      layers.current.cDrop = L.marker([r.dropoff.lat, r.dropoff.lng], { icon: pinIcon('🏁', '#0a84ff') }).addTo(map.current).bindTooltip('Arrivée');
    };
    const onStatus = ({ status: s, ride: r }) => { setStatus(s); if (r) setRide(r); };
    const onMsg = ({ message }) => {
      setMessages((m) => [...m, message]);
      if (message.from !== 'driver') setUnread((u) => (chatRef.current ? 0 : u + 1));
    };
    socket.on('ride:request', onReq);
    socket.on('ride:taken', onTaken);
    socket.on('ride:accepted', onAccepted);
    socket.on('ride:status', onStatus);
    socket.on('chat:message', onMsg);
    return () => {
      socket.off('ride:request', onReq); socket.off('ride:taken', onTaken);
      socket.off('ride:accepted', onAccepted); socket.off('ride:status', onStatus); socket.off('chat:message', onMsg);
    };
  }, []);

  const toggle = (v) => { setOnline(v); socket.emit('driver:online', { online: v }); if (!v) setRequests([]); };
  const accept = (r) => socket.emit('ride:accept', { rideId: r.id });
  const setRideStatus = (s) => socket.emit('ride:status', { rideId: ride.id, status: s });
  const sendMsg = (text) => socket.emit('chat:message', { rideId: ride.id, text, from: 'driver', name });
  const clearRide = () => {
    setRide(null); setStatus('idle'); setMessages([]); setChatOpen(false);
    ['cPickup', 'cDrop'].forEach((k) => { if (layers.current[k]) { map.current.removeLayer(layers.current[k]); layers.current[k] = null; } });
  };

  const active = ['accepted', 'arrived', 'in_progress'].includes(status);

  return (
    <React.Fragment>
      <div className="topbar"><button onClick={() => location.reload()}>← Rôle</button></div>
      {online && !active &&
        <div className="hint">🗺️ Touche la carte pour te déplacer · en attente de courses</div>}

      {active &&
        <button className="chat-toggle" onClick={() => setChatOpen(true)}>💬
          {unread > 0 && <span className="chat-badge">{unread}</span>}</button>}
      {chatOpen &&
        <Chat title={ride?.clientName || 'Client'} sub="Client"
          messages={messages} me="driver" onSend={sendMsg} onClose={() => setChatOpen(false)} />}

      <div className="sheet">
        <div className="grab"></div>
        <div className="row between">
          <div className="title">Salut {name} 👋</div>
          <span className={'badge ' + (online ? 'on' : '')}>{online ? '● En ligne' : '○ Hors ligne'}</span>
        </div>

        {!active && (
          <div className="toggle">
            <button className={!online ? 'active' : ''} onClick={() => toggle(false)}>Hors ligne</button>
            <button className={online ? 'active' : ''} onClick={() => toggle(true)}>En ligne</button>
          </div>
        )}

        {online && !active && (
          <React.Fragment>
            <div className="muted">{requests.length ? `${requests.length} demande(s) autour de toi` : 'En attente de demandes…'}</div>
            {requests.map((r) => (
              <div className="req-item" key={r.id}>
                <div className="row between">
                  <b>{r.clientName}</b>
                  <span className="status-pill">{fmtPrice(r.estimate.price)}</span>
                </div>
                <div className="muted">🟢 Départ · 🏁 {r.estimate.km} km · ~{r.estimate.min} min</div>
                <button className="btn-blue" onClick={() => accept(r)}>Accepter la course</button>
              </div>
            ))}
          </React.Fragment>
        )}

        {active && ride && (
          <React.Fragment>
            <div className="driver-info">
              <div className="avatar" style={{ background: 'linear-gradient(135deg,#ffb020,#ff7a00)' }}>{ride.clientName[0]}</div>
              <div style={{ flex: 1 }}>
                <div className="title">{ride.clientName}</div>
                <div className="muted">{fmtPrice(ride.estimate.price)} · {ride.estimate.km} km · {ride.estimate.min} min</div>
              </div>
              <button className="btn-blue" style={{ width: 'auto', padding: '10px 14px' }} onClick={() => setChatOpen(true)}>💬</button>
            </div>
            {status === 'accepted' && <button className="btn-primary" onClick={() => setRideStatus('arrived')}>Je suis arrivé au départ</button>}
            {status === 'arrived' && <button className="btn-primary" onClick={() => setRideStatus('in_progress')}>Démarrer la course</button>}
            {status === 'in_progress' && <button className="btn-primary" onClick={() => setRideStatus('completed')}>Terminer la course</button>}
            <div className="muted" style={{ textAlign: 'center' }}>Touche la carte pour déplacer ta position 🚕</div>
          </React.Fragment>
        )}

        {status === 'completed' && (
          <React.Fragment>
            <div className="status-pill">Course terminée ✅</div>
            <div className="title">+{fmtPrice(ride?.estimate.price)} encaissés</div>
            <button className="btn-primary" onClick={clearRide}>Continuer</button>
          </React.Fragment>
        )}
        {status === 'cancelled' && (
          <React.Fragment>
            <div className="status-pill" style={{ background: '#2a1416', color: '#ff4d5e' }}>Course annulée par le client</div>
            <button className="btn-primary" onClick={clearRide}>Continuer</button>
          </React.Fragment>
        )}
      </div>
    </React.Fragment>
  );
}

// ===========================================================================
function Chat({ title, sub, messages, me, onSend, onClose }) {
  const [text, setText] = useState('');
  const bodyRef = useRef(null);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [messages]);
  const send = () => { const t = text.trim(); if (!t) return; onSend(t); setText(''); };
  return (
    <div className="chat">
      <div className="chat-head">
        <button onClick={onClose}>←</button>
        <div className="avatar" style={{ width: 40, height: 40, fontSize: 16 }}>{title[0]}</div>
        <div><div style={{ fontWeight: 700 }}>{title}</div><div className="muted">{sub}</div></div>
      </div>
      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && <div className="muted" style={{ textAlign: 'center', marginTop: 20 }}>Démarrez la conversation…</div>}
        {messages.map((m, i) => (
          <div key={i} className={'msg ' + (m.from === me ? 'me' : 'them')}>
            {m.text}
            <small>{new Date(m.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</small>
          </div>
        ))}
      </div>
      <div className="chat-input">
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Écris un message…" />
        <button onClick={send}>➤</button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
