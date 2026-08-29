import { describe, expect, it } from 'vitest';
import { ManualClock, VirtualClock } from '../src/lib/clock.js';

describe('VirtualClock', () => {
  it('reports virtual time scaled up from real elapsed time', async () => {
    const clock = new VirtualClock(0.05); // 20x faster than real
    await clock.sleep(200); // ~10ms of real time
    // Virtual time advanced by roughly the requested amount, not the real 10ms.
    expect(clock.now()).toBeGreaterThan(120);
  });

  it('rejects a non-positive time scale', () => {
    expect(() => new VirtualClock(0)).toThrow(/greater than 0/);
    expect(() => new VirtualClock(-1)).toThrow();
  });

  it('returns immediately for a non-positive sleep', async () => {
    const clock = new VirtualClock(1);
    const before = Date.now();
    await clock.sleep(0);
    await clock.sleep(-50);
    expect(Date.now() - before).toBeLessThan(20);
  });
});

describe('ManualClock', () => {
  it('holds sleepers until time is advanced past their deadline', async () => {
    const clock = new ManualClock();
    const order: string[] = [];

    void clock.sleep(100).then(() => order.push('first'));
    void clock.sleep(300).then(() => order.push('third'));
    void clock.sleep(200).then(() => order.push('second'));

    await clock.advance(50);
    expect(order).toEqual([]);

    await clock.advance(60);
    expect(order).toEqual(['first']);

    await clock.advance(250);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(clock.now()).toBe(360);
  });
});
