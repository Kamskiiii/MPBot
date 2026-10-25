import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = 3000;
const BOT_SECRET = process.env.VP_DISCORD_BOT_SECRET || 'vpsecreet_trojan_2026';
const DB_FILE = path.resolve('./db.json');

// ID вашего сервера Arma 3 на BattleMetrics
const BATTLEMETRICS_SERVER_ID = '30475083';

function loadDb() {
  const dbFile = path.resolve('./db.json');
  const configFile = path.resolve('./config.json');

  let fileConfig = {};
  if (fs.existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      console.warn('Error reading config.json:', e.message);
    }
  }

  let data = {};
  if (fs.existsSync(dbFile)) {
    try {
      data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (e) {
      data = {};
    }
  }

  if (!data.config) data.config = {};

  // Принудительно подтягиваем и объединяем абсолютно все поля из config.json
  data.config = {
    ...fileConfig,
    ...data.config,
    wantedPanelChannelId: fileConfig.wantedPanelChannelId || data.config.wantedPanelChannelId || "1539050200314941550",
    wantedDossierChannelId: fileConfig.wantedDossierChannelId || data.config.wantedDossierChannelId || "1539050200314941550",
    wantedAlertChannelIds: fileConfig.wantedAlertChannelIds || data.config.wantedAlertChannelIds || ["1267089074364092457"],
    actionsPanelChannelId: fileConfig.actionsPanelChannelId || data.config.actionsPanelChannelId || ["1534839461068931103"],
  };

  if (!data.channels) data.channels = [];
  if (!data.wantedPersons) data.wantedPersons = [];
  if (!data.sessions) data.sessions = [];
  if (!data.activeSessions) data.activeSessions = {};
  if (!data.pendingAlertJobs) data.pendingAlertJobs = [];
  if (!data.pendingDossierJobs) data.pendingDossierJobs = [];
  if (!data.activeAlerts) data.activeAlerts = {};
  if (!data.activeDossiers) data.activeDossiers = {};

  // Сразу сохраняем объединенный вариант
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
  return data;
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let onlinePlayersCache = [];

// Генерация payload для аналитики (wanted-dossier-poller.ts)
function generateAnalytics(person, db) {
  const personSessions = db.sessions.filter(s => s.personId === person.id);
  const sessionCount = personSessions.length;
  const reliable = sessionCount >= 3;

  let medianSession = 'Менее 5 мин';
  if (sessionCount > 0) {
    const durations = personSessions.map(s => (s.end ? s.end - s.start : Date.now() - s.start)).sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const medianMs = durations.length % 2 !== 0 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
    const mins = Math.round(medianMs / 60000);
    medianSession = mins > 60 ? `${(mins / 60).toFixed(1)} ч.` : `${mins} мин.`;
  }

  const heatmapLines = [
    'Пн | ░░▒▓██████▓▒░░░░░░░░░░░░░░',
    'Вт | ░░░░▒▓████████▓▒░░░░░░░░░░',
    'Ср | ░░░░░░▒▓████▓▒░░░░░░░░░░░░',
    'Чт | ░░▒▓██████████▓▒░░░░░░░░░░',
    'Пт | ░░░░▒▓██████████████▓▒░░░░',
    'Сб | ░░▒▓████████████████▓▒░░░░',
    'Вс | ░░▒▓██████████████▓▒░░░░░░'
  ];

  const coPresenceMap = {};
  personSessions.forEach(s => {
    (s.onlinePlayersList || []).forEach(name => {
      if (name !== person.fullName.toLowerCase().trim()) {
        coPresenceMap[name] = (coPresenceMap[name] || 0) + 1;
      }
    });
  });

  const coPresence = Object.entries(coPresenceMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({
      name: name.toUpperCase(),
      unit: 'Случайный союзник',
      overlap: `${count} сесс.`,
      lift: `${(1.2 + count * 0.1).toFixed(1)}x`
    }));

  return {
    fullName: person.fullName,
    wantedClass: person.wantedClass,
    reward: person.reward,
    reason: person.reason,
    steam64: person.steam64,
    serverName: person.fullName,
    online: !!db.activeSessions[person.id],
    closed: !person.active,
    siteUrl: null,
    heatmapLines,
    typicalWindow: sessionCount > 0 ? 'Вечерний прайм-тайм (18:00 - 23:00)' : 'Недостаточно данных',
    medianSession,
    sessionCount,
    reliable,
    anomalies: sessionCount > 5 ? ['Частые сессии'] : [],
    coPresence,
    operatorRoleIds: db.config.wantedOperatorRoleIds || [],
    threadName: `Розыск — ${person.fullName}`
  };
}

// Фоновый опрос BattleMetrics API
async function updateOnlinePlayers() {
  try {
    const res = await fetch(`https://api.battlemetrics.com/servers/${BATTLEMETRICS_SERVER_ID}?include=player`);
    if (!res.ok) return;
    const data = await res.json();
    const playersData = data.included || [];
    
    const currentNames = playersData
      .filter((item) => item.type === 'player')
      .map((p) => (p.attributes?.name || '').toLowerCase().trim());

    onlinePlayersCache = currentNames;
    const db = loadDb();
    const now = Date.now();

    db.wantedPersons.forEach((person) => {
      if (person.active === false) return;

      const cleanName = person.fullName.toLowerCase().trim();
      const isOnline = currentNames.some((name) => name.includes(cleanName) || cleanName.includes(name));
      const wasOnline = !!db.activeSessions[person.id];

      // Игрок зашел на сервер
      if (isOnline && !wasOnline) {
        db.activeSessions[person.id] = now;

        const channelId = db.config.wantedAlertChannelIds?.[0];
        if (channelId) {
          db.pendingAlertJobs.push({
            id: 'alert_in_' + now + '_' + person.id,
            kind: 'post',
            channelId: channelId,
            fullName: person.fullName,
            wantedClass: person.wantedClass,
            reward: person.reward,
            reason: person.reason,
            serverName: person.fullName,
            gifUrl: db.config.wantedAlertGifUrl,
            pingRoleIds: db.config.wantedAlertRoleIds,
          });
        }

        const dossierChannelId = db.config.wantedDossierChannelId;
        if (dossierChannelId && !db.activeDossiers[person.id]) {
          db.pendingDossierJobs.push({
            id: 'dossier_open_' + now + '_' + person.id,
            kind: 'open',
            channelId: dossierChannelId,
            payload: generateAnalytics(person, db)
          });
        }
      } 
      // Игрок вышел с сервера
      else if (!isOnline && wasOnline) {
        const startTime = db.activeSessions[person.id];
        delete db.activeSessions[person.id];

        db.sessions.push({
          personId: person.id,
          start: startTime,
          end: now,
          onlinePlayersList: currentNames
        });

        const activeMessageId = db.activeAlerts[person.id];
        const channelId = db.config.wantedAlertChannelIds?.[0];
        if (channelId && activeMessageId) {
          db.pendingAlertJobs.push({
            id: 'alert_out_' + now + '_' + person.id,
            kind: 'edit',
            channelId: channelId,
            messageId: activeMessageId,
            fullName: person.fullName,
            wantedClass: person.wantedClass,
            reward: person.reward,
            reason: person.reason,
            serverName: person.fullName,
          });
          delete db.activeAlerts[person.id];
        }

        const dossierChannelId = db.config.wantedDossierChannelId;
        const dossierInfo = db.activeDossiers[person.id];
        if (dossierChannelId && dossierInfo) {
          db.pendingDossierJobs.push({
            id: 'dossier_update_' + now + '_' + person.id,
            kind: 'update',
            channelId: dossierChannelId,
            threadId: dossierInfo.threadId,
            starterMessageId: dossierInfo.starterMessageId,
            cardMessageId: dossierInfo.cardMessageId,
            analyticsMessageId: dossierInfo.analyticsMessageId,
            payload: generateAnalytics(person, db)
          });
        }
      }
    });

    saveDb(db);
  } catch (err) {
    console.warn('BattleMetrics fetch error:', err.message);
  }
}

setInterval(updateOnlinePlayers, 45_000);
setTimeout(updateOnlinePlayers, 2000);

// Middleware авторизации агента
app.use('/api/vp-agent', (req, res, next) => {
  const secret = req.headers['x-bot-secret'];
  if (secret !== BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Конфигурация бота
app.get('/api/vp-agent/bot-config', (req, res) => res.json(loadDb().config));

app.patch('/api/vp-agent/bot-config/panel-sync-ack', (req, res) => {
  const db = loadDb();
  db.config.wantedPanelSyncRequested = false;
  saveDb(db);
  res.status(200).send();
});

app.patch('/api/vp-agent/bot-config/wanted-panel-message', (req, res) => {
  const db = loadDb();
  db.config.wantedPanelMessageId = req.body.messageId;
  saveDb(db);
  res.status(200).send();
});

app.post('/api/vp-agent/channel-catalog', (req, res) => {
  const db = loadDb();
  db.channels = req.body.channels || [];
  saveDb(db);
  res.status(200).send();
});

// Доска розыска
app.get('/api/vp-agent/wanted-board', (req, res) => {
  const db = loadDb();
  const persons = db.wantedPersons.filter((p) => p.active !== false).map(p => {
    const isOnline = !!db.activeSessions[p.id];
    return {
      ...p,
      online: isOnline,
      serverName: isOnline ? p.fullName : null
    };
  });
  res.json({
    persons,
    panelChannelId: db.config.wantedPanelChannelId,
    panelMessageId: db.config.wantedPanelMessageId,
  });
});

// Создание записи в розыске
app.post('/api/vp-agent/wanted/persons', (req, res) => {
  const db = loadDb();
  const newPerson = {
    id: Date.now().toString(),
    fullName: req.body.fullName,
    steam64: req.body.steam64 || null,
    reason: req.body.reason,
    wantedClass: req.body.wantedClass,
    reward: req.body.reward || 0,
    active: true,
    createdAt: new Date().toISOString(),
  };
  db.wantedPersons.push(newPerson);

  const dossierChannelId = db.config.wantedDossierChannelId;
  if (dossierChannelId) {
    db.pendingDossierJobs.push({
      id: 'dossier_open_new_' + newPerson.id,
      kind: 'open',
      channelId: dossierChannelId,
      payload: generateAnalytics(newPerson, db)
    });
  }

  saveDb(db);
  res.json(newPerson);
});

// Снятие с розыска
app.patch('/api/vp-agent/wanted/persons/:id/deactivate', (req, res) => {
  const db = loadDb();
  const person = db.wantedPersons.find((p) => p.id === req.params.id);
  if (person) {
    person.active = false;
    delete db.activeAlerts[person.id];

    const dossierChannelId = db.config.wantedDossierChannelId;
    const dossierInfo = db.activeDossiers[person.id];
    if (dossierChannelId && dossierInfo) {
      db.pendingDossierJobs.push({
        id: 'dossier_close_' + Date.now() + '_' + person.id,
        kind: 'close',
        channelId: dossierChannelId,
        threadId: dossierInfo.threadId,
        starterMessageId: dossierInfo.starterMessageId,
        cardMessageId: dossierInfo.cardMessageId,
        analyticsMessageId: dossierInfo.analyticsMessageId,
        payload: generateAnalytics(person, db)
      });
      delete db.activeDossiers[person.id];
    }

    saveDb(db);
    res.json(person);
  } else {
    res.status(404).json({ error: 'Person not found' });
  }
});

// Очередь алертов
app.get('/api/vp-agent/wanted-alert-jobs/pending', (req, res) => {
  const db = loadDb();
  res.json({ items: db.pendingAlertJobs || [] });
});

app.post('/api/vp-agent/wanted-alert-jobs/ack', (req, res) => {
  const db = loadDb();
  const { jobId, messageId } = req.body;
  db.pendingAlertJobs = (db.pendingAlertJobs || []).filter((j) => j.id !== jobId);
  if (messageId) {
    const matchedPerson = db.wantedPersons.find(p => jobId.includes(p.id));
    if (matchedPerson) {
      db.activeAlerts[matchedPerson.id] = messageId;
    }
  }
  saveDb(db);
  res.status(200).send();
});

// Очередь досье
app.get('/api/vp-agent/wanted-dossier-jobs/pending', (req, res) => {
  const db = loadDb();
  res.json({ items: db.pendingDossierJobs || [] });
});

app.post('/api/vp-agent/wanted-dossier-jobs/ack', (req, res) => {
  const db = loadDb();
  const { jobId, threadId, starterMessageId, cardMessageId, analyticsMessageId } = req.body;
  
  db.pendingDossierJobs = (db.pendingDossierJobs || []).filter((j) => j.id !== jobId);

  const matchedPerson = db.wantedPersons.find(p => jobId.includes(p.id));
  if (matchedPerson && threadId) {
    db.activeDossiers[matchedPerson.id] = {
      threadId,
      starterMessageId,
      cardMessageId,
      analyticsMessageId
    };
  }

  saveDb(db);
  res.status(200).send();
});

app.get('/api/vp-agent/channel-message-jobs/pending', (req, res) => res.json({ items: [] }));
app.post('/api/vp-agent/channel-message-jobs/ack', (req, res) => res.status(200).send());

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VDV Full Backend running on port ${PORT}`);
});