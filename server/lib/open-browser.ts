/**
 * Open a URL in the user's default browser, cross-platform.
 *
 * Used by the `--open` launch flag so the desktop installers can start the
 * server and drop the user straight onto the UI. Best-effort: failures are
 * swallowed (the URL is always printed to stdout regardless).
 *
 * Only ever called with our own loopback app URL — no untrusted input reaches
 * the shell. We still avoid a shell and pass the URL as a single argv element.
 */

import { spawn } from 'child_process';

export async function openBrowser(url: string): Promise<void> {
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (platform === 'win32') {
      // `start` is a cmd builtin, not an exe. Pass an empty title arg ("") so a
      // quoted URL isn't mistaken for the window title. No shell interpolation
      // of the URL: it's our own constant loopback address.
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }

    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* best-effort: browser may be opened manually */
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}
