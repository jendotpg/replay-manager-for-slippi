import { Beamer } from './types';

export function labelFor(
  beamer: Pick<Beamer, 'beamerName' | 'beamerId' | 'address'>,
) {
  return beamer.beamerName || beamer.beamerId || beamer.address;
}
