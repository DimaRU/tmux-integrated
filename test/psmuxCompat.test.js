/**
 * Tests for psmux-specific workarounds.
 *
 * psmux's `-CC` client relays each server line to stdout after logging a
 * byte-sliced `&line[..200]`; when byte 200 falls inside a multi-byte UTF-8
 * character the relay thread panics and the control channel goes silent while
 * the process stays alive. capture-pane is the one response that carries raw
 * UTF-8 lines of arbitrary length, so re-adopting a window must not send it
 * to psmux.
 */
const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

class Disposable {
  dispose() {}
}

class VscodeEventEmitter {
  constructor() {
    this.emitter = new events.EventEmitter();
    this.event = (listener) => {
      this.emitter.on('event', listener);
      return new Disposable();
    };
  }

  fire(value) {
    this.emitter.emit('event', value);
  }
}

const vscodeMock = { Disposable, EventEmitter: VscodeEventEmitter, TerminalExitReason: {} };
const originalLoad = Module._load;
Module._load = function loadMockedModule(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad(request, parent, isMain);
};
const { TmuxTerminal } = require('../out/tmuxTerminalProvider.js');
const { TmuxControlClient } = require('../out/tmuxControlClient.js');
Module._load = originalLoad;

class FakeTmuxClient extends events.EventEmitter {
  constructor(isPsmux) {
    super();
    this.isPsmux = isPsmux;
    this.captures = 0;
  }

  isConnected() {
    return true;
  }

  async sendCommand() {
    return [];
  }

  async sendCommandList(commands) {
    return commands.map(() => []);
  }

  async getWindowName() {
    return 'tmux:0';
  }

  async getWindowAutomaticRename() {
    return false;
  }

  async resizeWindowForClient() {}

  async capturePane() {
    this.captures += 1;
    return 'history';
  }

  async getPaneCursor() {
    return { x: 0, y: 0 };
  }

  removePaneDecoder() {}
}

async function adoptWindow(client) {
  const pty = new TmuxTerminal(
    client,
    undefined,
    {},
    'cmd.exe',
    false,
    { windowId: '@1', paneId: '%1', windowIndex: 0, name: 'tmux:0', automaticRename: false },
    undefined,
    () => false,
    () => {},
  );
  await pty.open({ columns: 80, rows: 24 });
  return pty;
}

test('psmux is detected from its -V output', () => {
  const client = new TmuxControlClient('s', 'tmux', '/nonexistent');
  client.setVersion('tmux 3.3.8\npsmux 3.3.8 (66cf613 2026-08-18)');
  assert.equal(client.isPsmux, true);
  assert.equal(client.versionAtLeast(3, 3), true);

  client.setVersion('tmux 3.5a');
  assert.equal(client.isPsmux, false);
});

test('adopting a window on tmux seeds the tab from capture-pane', async () => {
  const client = new FakeTmuxClient(false);
  await adoptWindow(client);
  assert.equal(client.captures, 1);
});

test('adopting a window on psmux skips capture-pane', async () => {
  const client = new FakeTmuxClient(true);
  await adoptWindow(client);
  assert.equal(client.captures, 0);
});
