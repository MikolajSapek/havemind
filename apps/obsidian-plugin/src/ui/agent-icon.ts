/**
 * Draws an agent's pixel icon (plan 016) as one crisp SVG path in
 * `currentColor`, so the caller's CSS decides ink and size. Decorative: the
 * agent's name always sits next to it.
 */

import { ICON_SIZE, iconPixels } from '../runtime/agent-icons';

export function agentIconPath(id: string): string {
  return iconPixels(id)
    .map(([x, y]) => `M${x} ${y}h1v1h-1z`)
    .join('');
}

export function renderAgentIcon(
  parent: HTMLElement | SVGElement,
  id: string,
  cls: string,
  place: Record<string, string> = {},
): SVGSVGElement {
  const svg = (parent as HTMLElement).createSvg('svg', {
    cls,
    attr: {
      ...place,
      viewBox: `0 0 ${ICON_SIZE} ${ICON_SIZE}`,
      'shape-rendering': 'crispEdges',
      'aria-hidden': 'true',
      focusable: 'false',
    },
  });
  svg.createSvg('path', { attr: { d: agentIconPath(id), fill: 'currentColor' } });
  return svg;
}
