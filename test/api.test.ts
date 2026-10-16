import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiClient, ApiError } from '../src/api.js';
import { parseFileConfig } from '../src/config.js';
import { openStore } from '../src/store.js';

const file = parseFileConfig({
  guestRoleId: 'guest',
  positionRoleIds: ['p1', 'p2'],
  positionCategoryRoleId: 'cat',
  otherRoleIds: ['o1'],
  leaveNotifyChannelId: 'notify',
  leaveActiveRoleId: 'onleave',
});

const make = () => createApiClient({ store: openStore(':memory:'), file, vdv: null });

const candidate = {
  applicantDiscordUserId: 'u1',
  fullName: 'Иван',
  age: '20',
  hoursPerWeek: '10',
  armaExperience: 'да',
  threadId: 't1',
};

test('заявка: дубль → 409, одобрение требует должность из списка', async () => {
  const api = make();
  const row = await api.createRequest({ type: 'candidate_application', payload: candidate });
  await assert.rejects(
    api.createRequest({ type: 'candidate_application', payload: candidate }),
    (e) => e instanceof ApiError && e.status === 409,
  );
  await assert.rejects(api.setStatus(row.id, 'approved', 'mod'), (e) => (e as ApiError).status === 400);
  await assert.rejects(
    api.setStatus(row.id, 'approved', 'mod', { positionRoleId: 'nope' }),
    (e) => (e as ApiError).status === 400,
  );

  const res = await api.setStatus(row.id, 'approved', 'mod', { positionRoleId: 'p1' });
  assert.deepEqual(res.discordRoleSync?.addRoleIds, ['p1', 'cat']);
  assert.deepEqual(res.discordRoleSync?.removeRoleIds.sort(), ['guest', 'p2']);
  assert.equal((await api.getPendingRequests()).length, 0);
  await assert.rejects(api.setStatus(row.id, 'rejected'), (e) => (e as ApiError).status === 409);
});

test('роли: нужна должность или «Прочее», чужие роли отклоняются', async () => {
  const api = make();
  const base = { applicantDiscordUserId: 'u2', threadId: 't2' };
  await assert.rejects(api.createRequest({ type: 'decorative_role_request', payload: base }));
  await assert.rejects(
    api.createRequest({ type: 'decorative_role_request', payload: { ...base, otherRoleIds: ['x'] } }),
  );
  const row = await api.createRequest({
    type: 'decorative_role_request',
    payload: { ...base, otherRoleIds: ['o1'] },
  });
  const res = await api.setStatus(row.id, 'approved', 'mod');
  assert.deepEqual(res.discordRoleSync, {
    targetDiscordUserId: 'u2',
    addRoleIds: ['o1'],
    removeRoleIds: [],
  });
});

test('отпуск: одобрение создаёт уведомление, просроченный закрывается', async () => {
  const api = make();
  const row = await api.createRequest({
    type: 'leave_request',
    payload: { applicantDiscordUserId: 'u3', threadId: 't3', startDate: '2020-01-01', endDate: '2020-01-02' },
  });
  await assert.rejects(
    api.createRequest({
      type: 'leave_request',
      payload: { applicantDiscordUserId: 'u4', threadId: 't4', startDate: '2020-02-01', endDate: '2020-01-01' },
    }),
  );
  const res = await api.setStatus(row.id, 'approved', 'mod');
  assert.equal(res.leaveNotify?.channelId, 'notify');
  assert.deepEqual(res.discordRoleSync?.addRoleIds, ['onleave']);
  await api.setLeaveNotifyMessage(res.leaveNotify!.leaveId, 'notify', 'm1');

  const { items } = await api.getPendingLeaveNotifyEdits();
  assert.equal(items.length, 1);
  assert.equal(items[0].messageId, 'm1');
  await api.ackLeaveNotifyEdit(items[0].leaveId);
  assert.equal((await api.getPendingLeaveNotifyEdits()).items.length, 0);
});

test('панели: флаги синка и id сообщений хранятся локально', async () => {
  const api = make();
  assert.equal((await api.getBotConfig()).welcomePanelSyncRequested, false);
  api.requestPanelSync();
  await api.setWelcomePanelMessageId('m42');
  let cfg = await api.getBotConfig();
  assert.equal(cfg.welcomePanelSyncRequested, true);
  assert.equal(cfg.welcomePanelMessageId, 'm42');
  await api.ackPanelSync({ welcomePanel: true });
  cfg = await api.getBotConfig();
  assert.equal(cfg.welcomePanelSyncRequested, false);
  assert.equal(cfg.actionsPanelSyncRequested, true);
});

test('без VDV удалённые методы отвечают 503', async () => {
  await assert.rejects(make().getWantedBoard(), (e) => (e as ApiError).status === 503);
});
