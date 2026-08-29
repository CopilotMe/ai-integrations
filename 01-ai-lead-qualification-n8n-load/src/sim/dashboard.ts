import type { SimulationProgress } from './runner.js';

const ESC = '\x1b[';

/**
 * Live terminal dashboard.
 *
 * Redraws in place while the run is in flight, because the interesting part of
 * a load test is watching the queue fill and drain — a wall of scrolling log
 * lines carries the same data and communicates none of it. Falls back to
 * periodic one-line updates when stdout is not a TTY (CI, piped output).
 */
export class Dashboard {
  private readonly isTty: boolean;
  private linesDrawn = 0;
  private lastPrintedAt = 0;

  constructor(
    private readonly total: number,
    private readonly stream: NodeJS.WriteStream = process.stdout,
    forceTty?: boolean,
  ) {
    this.isTty = forceTty ?? Boolean(stream.isTTY);
  }

  render(progress: SimulationProgress): void {
    if (!this.isTty) {
      // One line every ~2s of virtual time keeps piped output readable.
      if (progress.elapsedMs - this.lastPrintedAt < 2000) return;
      this.lastPrintedAt = progress.elapsedMs;
      this.stream.write(
        `  ${pct(progress.completed + progress.rejected, this.total)} ` +
          `done=${progress.completed} rejected=${progress.rejected} dead=${progress.dead} ` +
          `queue=${progress.queueDepth} inflight=${progress.inFlight} ` +
          `${progress.throughput.toFixed(1)}/s $${progress.costUsd.toFixed(4)}\n`,
      );
      return;
    }

    const settled = progress.completed + progress.rejected + progress.dead;
    const lines = [
      '',
      `  ${bold('AI Lead Qualification — load simulation')}`,
      '',
      `  ${bar(settled, this.total, 42)}  ${settled}/${this.total}`,
      '',
      `  ${label('queued')}${pad(progress.queueDepth, 8)}${label('in flight')}${pad(progress.inFlight, 8)}${label('retries')}${pad(progress.retries, 8)}`,
      `  ${label('done')}${pad(progress.completed, 8)}${label('rejected')}${pad(progress.rejected, 8)}${label('dead')}${pad(progress.dead, 8)}`,
      '',
      `  ${label('throughput')}${pad(`${progress.throughput.toFixed(1)}/s`, 8)}${label('elapsed')}${pad(`${(progress.elapsedMs / 1000).toFixed(1)}s`, 8)}${label('cost')}${dim(`$${progress.costUsd.toFixed(4)}`)}`,
      '',
      `  ${dim('HOT')} ${progress.classifications.HOT ?? 0}   ${dim('WARM')} ${progress.classifications.WARM ?? 0}   ${dim('COLD')} ${progress.classifications.COLD ?? 0}`,
      '',
    ];

    this.clear();
    this.stream.write(lines.join('\n') + '\n');
    this.linesDrawn = lines.length + 1;
  }

  /** Leaves the final frame on screen and stops redrawing over it. */
  finish(): void {
    this.linesDrawn = 0;
  }

  private clear(): void {
    if (this.linesDrawn === 0) return;
    this.stream.write(`${ESC}${this.linesDrawn}A${ESC}0J`);
  }
}

function bar(value: number, total: number, width: number): string {
  const ratio = total === 0 ? 0 : Math.min(1, value / total);
  const filled = Math.round(ratio * width);
  return `${'█'.repeat(filled)}${dim('░'.repeat(width - filled))} ${(ratio * 100).toFixed(0).padStart(3)}%`;
}

function pct(value: number, total: number): string {
  return `${((total === 0 ? 0 : value / total) * 100).toFixed(0).padStart(3)}%`;
}

const label = (text: string): string => dim(text.padEnd(12));
const pad = (value: string | number, width: number): string => String(value).padEnd(width);
const dim = (text: string): string => `${ESC}2m${text}${ESC}0m`;
const bold = (text: string): string => `${ESC}1m${text}${ESC}0m`;
