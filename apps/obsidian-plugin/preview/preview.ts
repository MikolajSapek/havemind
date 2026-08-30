/**
 * The first-run screens in a browser, for looking at rather than for shipping.
 *
 * It imports the shipping renderers and the shipping `styles.css`, so what you
 * see is what the pane draws. The one thing it adds is a width control: the
 * inset defect was invisible at a comfortable width and obvious at 300px, which
 * is where the sidebar actually lives.
 */

import './obsidian-shim';

import { buildEntryChooser, buildHostView } from '../src/runtime/entry-choice';
import {
  renderEntryChooser,
  renderHostPath,
} from '../src/ui/entry-chooser-section';
import { renderPaneHeader } from '../src/ui/pane-header';

type Screen = 'chooser' | 'host';

let screen: Screen = 'chooser';

function paint(): void {
  const pane = document.getElementById('pane');
  if (pane === null) return;
  pane.empty();
  pane.className = 'havemind-view';

  // The view renders the header strip unconditionally, before it decides which
  // screen goes below it, so a first-run pane has chrome above the chooser.
  // Leaving it out here measured a pane that does not exist.
  renderPaneHeader(pane, {
    title: 'Havemind',
    items: [],
    menuOpen: false,
    onToggleMenu: () => undefined,
  });

  if (screen === 'chooser') {
    renderEntryChooser(pane, {
      model: buildEntryChooser(),
      onChoose: (choice) => {
        screen = choice === 'hosting' ? 'host' : 'chooser';
        paint();
        sync();
      },
    });
    return;
  }

  renderHostPath(pane, {
    model: buildHostView(),
    onBack: () => {
      screen = 'chooser';
      paint();
      sync();
    },
    onContinue: () => undefined,
    onOpenGuide: (url) => window.open(url, '_blank'),
  });
}

/** Keeps the screen buttons showing which screen is actually up. */
function sync(): void {
  for (const button of document.querySelectorAll('[data-screen]')) {
    button.classList.toggle(
      'is-active',
      button.getAttribute('data-screen') === screen,
    );
  }
}

function boot(): void {
  const frame = document.getElementById('frame');
  const width = document.getElementById('width') as HTMLInputElement | null;
  const readout = document.getElementById('width-readout');

  width?.addEventListener('input', () => {
    const value = width.value;
    if (frame !== null) frame.style.width = `${value}px`;
    if (readout !== null) readout.textContent = `${value}px`;
  });

  for (const button of document.querySelectorAll('[data-screen]')) {
    button.addEventListener('click', () => {
      screen = button.getAttribute('data-screen') as Screen;
      paint();
      sync();
    });
  }

  for (const button of document.querySelectorAll('[data-theme]')) {
    button.addEventListener('click', () => {
      const theme = button.getAttribute('data-theme');
      document.body.classList.toggle('theme-dark', theme === 'dark');
      document.body.classList.toggle('theme-light', theme !== 'dark');
      for (const other of document.querySelectorAll('[data-theme]')) {
        other.classList.toggle('is-active', other === button);
      }
    });
  }

  paint();
  sync();
}

boot();
