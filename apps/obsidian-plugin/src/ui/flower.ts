/**
 * Draws the flower: a hexagon core (the server) and six flat-top seats around it.
 *
 * Geometry only; every colour, dash and animation comes from `styles.css` through
 * the classes set here, so a theme can restyle it and nothing is inline.
 */

import type { FlowerModel, FlowerSeat } from '../runtime/flower-model';

/** Seat radius in viewBox units; the stylesheet scales the whole image. */
const R = 22;
/** Centre-to-seat distance: touching hexagons plus a 0.85 R gap for the spokes. */
const DIST = Math.sqrt(3) * R + 0.85 * R;
const APOTHEM = R * 0.866;
const WIDTH = Math.round(R * 9.2);
const HEIGHT = Math.round(WIDTH * 0.94);
const CX = WIDTH / 2;
const CY = HEIGHT / 2;

const fixed = (n: number): string => n.toFixed(1);

function hexPath(x: number, y: number, r: number): string {
  const points = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${fixed(x + r * Math.cos(a))} ${fixed(y + r * Math.sin(a))}`;
  });
  return `M${points.join('L')}Z`;
}

/**
 * The lower-right half of a flat-top hexagon, cut along the line through its
 * centre from upper right to lower left: the red side of a conflicted seat.
 */
function splitPath(x: number, y: number, r: number): string {
  const k = 0.634 * r;
  const h = 0.866 * r;
  const points: Array<[number, number]> = [
    [x + k, y - k],
    [x + r, y],
    [x + r / 2, y + h],
    [x - r / 2, y + h],
    [x - k, y + k],
  ];
  return `M${points.map(([px, py]) => `${fixed(px)} ${fixed(py)}`).join('L')}Z`;
}

function seatCentre(index: number): { x: number; y: number; angle: number } {
  const angle = ((-90 + 60 * index) * Math.PI) / 180;
  return { x: CX + DIST * Math.cos(angle), y: CY + DIST * Math.sin(angle), angle };
}

function spokePath(angle: number): string {
  const at = (k: number): string => `${fixed(CX + k * Math.cos(angle))} ${fixed(CY + k * Math.sin(angle))}`;
  return `M${at(APOTHEM + 4)}L${at(DIST - APOTHEM - 2)}`;
}

const HAS_SPOKE: ReadonlySet<FlowerSeat['kind']> = new Set(['member', 'self-offline', 'conflict', 'joining']);

export function renderFlower(parent: HTMLElement, model: FlowerModel): SVGSVGElement {
  const svg = parent.createSvg('svg', {
    cls: 'havemind-flower',
    attr: { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', 'aria-label': model.description },
  });
  svg.addClass(`is-${model.core}`);

  model.seats.forEach((seat, index) => {
    if (!HAS_SPOKE.has(seat.kind)) return;
    const spoke = svg.createSvg('path', { cls: 'havemind-flower-spoke', attr: { d: spokePath(seatCentre(index).angle) } });
    spoke.addClass(`is-${seat.kind}`);
  });

  svg.createSvg('path', { cls: 'havemind-flower-pulse', attr: { d: hexPath(CX, CY, R + 2) } });
  svg.createSvg('path', { cls: 'havemind-flower-core', attr: { d: hexPath(CX, CY, R + 2) } });
  svg.createSvg('circle', { cls: 'havemind-flower-core-dot', attr: { cx: fixed(CX), cy: fixed(CY), r: '5' } });

  model.seats.forEach((seat, index) => {
    const { x, y } = seatCentre(index);
    const cell = svg.createSvg('path', { cls: 'havemind-flower-seat', attr: { d: hexPath(x, y, R) } });
    cell.addClass(`is-${seat.kind}`);
    if (seat.kind === 'conflict') {
      svg.createSvg('path', { cls: 'havemind-flower-split', attr: { d: splitPath(x, y, R) } });
    }
    if (seat.label !== '') {
      const text = svg.createSvg('text', {
        cls: 'havemind-flower-label',
        attr: { x: fixed(x), y: fixed(y + 4), 'text-anchor': 'middle' },
      });
      text.addClass(`is-${seat.kind}`);
      text.setText(seat.label);
    }
  });
  return svg;
}
