import test from 'node:test';
import assert from 'node:assert/strict';

import { ActivityFooter, renderActivityFooterLine } from '../src/neal/activity-footer.js';

class FakeStream {
  isTTY: boolean;
  columns: number;
  writes: string[] = [];

  constructor(options: { isTTY: boolean; columns?: number }) {
    this.isTTY = options.isTTY;
    this.columns = options.columns ?? 120;
  }

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
}

test('renderActivityFooterLine summarizes read-only command activity', () => {
  const line = renderActivityFooterLine({
    mode: 'review',
    subject: 'last 2 commits',
    activity: 'reviewer checking review findings round 1/3',
    status: 'running',
    startedAt: 1_000,
    now: 126_000,
  });

  assert.equal(
    line,
    '[neal] review last 2 commits | activity: reviewer checking review findings round 1/3 | elapsed: 02:05 | status: running',
  );
});

test('ActivityFooter clears and redraws around narrative writes in TTY mode', () => {
  const stream = new FakeStream({ isTTY: true });
  const footer = new ActivityFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    now: () => 10_000,
  });

  footer.setState({
    mode: 'review',
    activity: 'coder drafting review findings round 1/3',
    status: 'running',
    startedAt: 0,
  });
  footer.write('[neal] ordinary line\n');

  assert.ok(stream.writes.length >= 4);
  assert.match(stream.writes[0] ?? '', /\r\x1b\[2K\[neal\] review/);
  assert.equal(stream.writes[1], '\r\x1b[2K');
  assert.equal(stream.writes[2], '[neal] ordinary line\n');
  assert.match(stream.writes[3] ?? '', /\r\x1b\[2K\[neal\] review/);

  footer.dispose();
});

test('ActivityFooter replaceView redraws the footer for detail toggles', () => {
  const stream = new FakeStream({ isTTY: true });
  const footer = new ActivityFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    now: () => 10_000,
  });

  footer.setState({
    mode: 'review',
    activity: 'coder drafting review findings round 1/3',
    status: 'running',
    startedAt: 0,
  });
  stream.writes = [];

  footer.replaceView('restored narrative\n');

  assert.equal(stream.writes[0], '\r\x1b[2K');
  assert.equal(stream.writes[1], '\x1b[H\x1b[2J');
  assert.equal(stream.writes[2], 'restored narrative\n');
  assert.match(stream.writes[3] ?? '', /\r\x1b\[2K\[neal\] review/);

  footer.dispose();
});

test('ActivityFooter writes plainly when the diagnostic stream is not a TTY', () => {
  const stream = new FakeStream({ isTTY: false });
  const footer = new ActivityFooter({
    stream,
    refreshIntervalMs: 0,
  });

  footer.setState({
    mode: 'review',
    activity: 'preparing review',
    status: 'running',
    startedAt: 0,
  });
  footer.write('[neal] plain line\n');
  footer.replaceView('plain replacement\n');

  assert.deepEqual(stream.writes, ['[neal] plain line\n', 'plain replacement\n']);
});
