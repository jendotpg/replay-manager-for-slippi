import {
  Alert,
  Avatar,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  DeleteForever,
  ErrorOutline,
  NotificationsActive,
  NotificationsNone,
  Refresh,
  Warning,
} from '@mui/icons-material';
import { useEffect, useRef, useState } from 'react';
import { BeamerGame, BeamerPort, Beamer } from '../common/types';
import { EMPTY_BEAMER_FLEET, characterNames } from '../common/constants';
import { labelFor } from '../common/beamers';
import getCharacterIcon from './getCharacterIcon';

function beamerKey(beamer: Beamer) {
  return beamer.beamerId || beamer.address;
}

function warningsFor(beamer: Beamer) {
  return beamer.warnings.join(', ');
}

function formatSecs(secs: number | null) {
  if (secs === null || secs < 0) {
    return '—';
  }
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m ${`${secs % 60}`.padStart(2, '0')}s`;
  }
  return `${Math.floor(mins / 60)}h ${`${mins % 60}`.padStart(2, '0')}m`;
}

function formatReplays(beamer: Beamer) {
  if (beamer.replayCount < 0) {
    return '\u2014';
  }
  return beamer.replayCap >= 0
    ? `${beamer.replayCount} / ${beamer.replayCap}`
    : `${beamer.replayCount}`;
}

function BeamersTooltip({
  showWarnings,
  beamers,
}: {
  showWarnings: boolean;
  beamers: Beamer[];
}) {
  return (
    <Stack gap="2px">
      {beamers.map((beamer) => {
        const warnings = showWarnings ? warningsFor(beamer) : '';
        return (
          <Typography key={beamerKey(beamer)} variant="caption">
            {warnings
              ? `${labelFor(beamer)} — ${warnings}`
              : labelFor(beamer)}
          </Typography>
        );
      })}
    </Stack>
  );
}

const MAX_GAMES_FROM_INDEX = 16; // NUM-REPLAYS-SERVED ceiling

const DOWN_WARNINGS = ['DRIVE FULL', 'NO WII']; // udate if more "can't write" warnings are added...

const HEALTH_COLOR: Record<Beamer['health'], string> = {
  ok: '#31d158',
  starting: '#8a8a8e',
  warn: '#f5a623',
  error: '#f04438',
  unknown: '#8a8a8e',
};

function LiveLight({ beamer }: { beamer: Beamer }) {
  const down =
    beamer.health === 'error' ||
    beamer.warnings.some((warning) => DOWN_WARNINGS.includes(warning));
  const color = down ? HEALTH_COLOR.error : HEALTH_COLOR[beamer.health];
  const live = Boolean(beamer.game?.live);
  const dot = (
    <span
      style={{
        backgroundColor: color,
        borderRadius: '50%',
        boxShadow: live ? `0 0 6px ${color}` : 'none',
        display: 'inline-block',
        height: '10px',
        width: '10px',
      }}
    />
  );
  const title =
    warningsFor(beamer) || (beamer.health === 'error' ? 'ERROR' : '');
  return title ? (
    <Tooltip arrow title={title}>
      {dot}
    </Tooltip>
  ) : (
    dot
  );
}

function PortCell({
  game,
  port,
}: {
  game: BeamerGame | null;
  port: BeamerPort | undefined;
}) {
  if (!port) {
    return <TableCell />;
  }
  const charName =
    (port.charId === null ? port.char : characterNames.get(port.charId)) ||
    port.char;
  return (
    <TableCell>
      <Stack alignItems="center" direction="row" gap="4px">
        <Tooltip arrow title={charName}>
          <Avatar
            alt={charName}
            src={getCharacterIcon(port.charId ?? 31, port.costume)}
            style={{ height: '24px', width: '24px' }}
            variant="square"
          />
        </Tooltip>
        <Typography
          color={game?.live ? 'text.primary' : 'text.secondary'}
          variant="body2"
        >
          {port.nametag || `P${port.port}`}
        </Typography>
      </Stack>
    </TableCell>
  );
}

export default function BeamerDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [fleet, setFleet] = useState(EMPTY_BEAMER_FLEET);
  const [copying, setCopying] = useState('');
  const [refreshing, setRefreshing] = useState('');
  const [subscribing, setSubscribing] = useState('');
  const [confirmingReset, setConfirmingReset] = useState<
    Beamer | 'all' | null
  >(null);
  const [resetting, setResetting] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [maxGamesFromIndex, setMaxGamesFromIndex] = useState(4);

  const baselines = useRef(new Map<string, { secs: number; at: number }>());
  const liveSecs = (key: string, reported: number | null) => {
    if (reported === null) {
      baselines.current.delete(key);
      return null;
    }
    const previous = baselines.current.get(key);
    if (!previous || previous.secs !== reported) {
      baselines.current.set(key, { secs: reported, at: Date.now() });
      return reported;
    }
    return previous.secs + Math.floor((now - previous.at) / 1000);
  };

  useEffect(() => {
    window.electron.onBeamerFleet((_event, newFleet) => {
      setFleet(newFleet);
    });
  }, []);

  useEffect(() => {
    if (!open) {
      window.electron.stopBeamerBrowse();
      return undefined;
    }

    setError('');
    (async () => {
      setMaxGamesFromIndex(await window.electron.getMaxGamesFromIndex());
      setFleet(await window.electron.getBeamerFleet());
      await window.electron.startBeamerBrowse();
    })();
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [open]);

  const select = async (beamerId: string) => {
    setCopying(beamerId);
    setError('');
    try {
      await window.electron.selectBeamer(beamerId);
      onClose();
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setCopying('');
    }
  };

  const refresh = async (beamerId: string) => {
    setRefreshing(beamerId);
    setError('');
    try {
      await window.electron.refreshBeamerStatus(beamerId);
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setRefreshing('');
    }
  };

  const toggleSubscribe = async (beamer: Beamer) => {
    setSubscribing(beamerKey(beamer));
    setError('');
    try {
      await window.electron.setBeamerSubscribed(
        beamerKey(beamer),
        !beamer.subscribed,
      );
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setSubscribing('');
    }
  };

  const refreshAll = async () => {
    setRefreshing('all');
    setError('');
    try {
      const failures = await window.electron.refreshAllBeamers();
      if (failures.length > 0) {
        setError(`Refreshed the rest, but not these:\n${failures.join('\n')}`);
      }
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setRefreshing('');
    }
  };

  const reset = async (beamer: Beamer) => {
    setResetting(beamerKey(beamer));
    setError('');
    try {
      await window.electron.resetBeamer(beamerKey(beamer));
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setResetting('');
      setConfirmingReset(null);
    }
  };

  const resetAll = async () => {
    setResetting('all');
    setError('');
    try {
      const failures = await window.electron.resetAllBeamers();
      if (failures.length > 0) {
        setError(`Erased the rest, but not these:\n${failures.join('\n')}`);
      }
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setResetting('');
      setConfirmingReset(null);
    }
  };

  const busy = Boolean(copying);
  const erroring = fleet.beamers.filter(
    (beamer) => beamer.health === 'error',
  );
  const warning = fleet.beamers.filter((beamer) => beamer.health === 'warn');

  let confirmingResetCount =
    "Every replay on this beamer's drive will be erased. This cannot be undone.";
  if (
    confirmingReset &&
    confirmingReset !== 'all' &&
    confirmingReset.replayCount >= 0
  ) {
    confirmingResetCount = `All ${confirmingReset.replayCount} replays on this beamer's drive will be erased. This cannot be undone.`;
  }

  return (
    <Dialog
      fullWidth
      maxWidth="md"
      open={open}
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <DialogTitle>
        <Stack
          alignItems="center"
          direction="row"
          justifyContent="space-between"
        >
          <Stack alignItems="center" direction="row" gap="8px">
            Beamers
            <Stack alignItems="baseline" direction="row" gap="4px">
              <TextField
                inputProps={{
                  min: 1,
                  max: MAX_GAMES_FROM_INDEX,
                  style: { textAlign: 'right' },
                }}
                onChange={async (event) => {
                  const parsed = parseInt(event.target.value, 10);
                  if (!Number.isInteger(parsed)) {
                    return;
                  }
                  const clamped = Math.min(
                    Math.max(parsed, 1),
                    MAX_GAMES_FROM_INDEX,
                  );
                  setMaxGamesFromIndex(clamped);
                  await window.electron.setMaxGamesFromIndex(clamped);
                }}
                size="small"
                style={{ width: '40px' }}
                type="number"
                value={maxGamesFromIndex}
                variant="standard"
              />
              <Typography variant="body2">games downloaded</Typography>
            </Stack>
            {erroring.length > 0 && (
              <Tooltip
                arrow
                title={
                  <BeamersTooltip showWarnings={false} beamers={erroring} />
                }
              >
                <Chip
                  color="error"
                  icon={<ErrorOutline />}
                  label={`${erroring.length} error${
                    erroring.length === 1 ? '' : 's'
                  }`}
                  size="small"
                />
              </Tooltip>
            )}
            {warning.length > 0 && (
              <Tooltip
                arrow
                title={<BeamersTooltip showWarnings beamers={warning} />}
              >
                <Chip
                  color="warning"
                  icon={<Warning />}
                  label={`${warning.length} warning${
                    warning.length === 1 ? '' : 's'
                  }`}
                  size="small"
                />
              </Tooltip>
            )}
          </Stack>
          {fleet.beamers.length > 0 && (
            <Stack alignItems="center" direction="row" gap="4px">
              <Tooltip
                arrow
                title="Re-run the status check on every beamer listed here"
              >
                <span>
                  <IconButton
                    disabled={busy || Boolean(refreshing) || Boolean(resetting)}
                    onClick={refreshAll}
                    size="small"
                  >
                    {refreshing === 'all' ? (
                      <CircularProgress size="20px" />
                    ) : (
                      <Refresh />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip
                arrow
                title="Erase the replays on every beamer listed here"
              >
                <span>
                  <Button
                    color="error"
                    disabled={busy || Boolean(resetting)}
                    onClick={() => setConfirmingReset('all')}
                    size="small"
                    startIcon={<DeleteForever />}
                  >
                    Erase all
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          )}
        </Stack>
      </DialogTitle>
      <DialogContent>
        {fleet.beamers.length > 0 ? (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell />
                <TableCell>Beamer</TableCell>
                <TableCell>Live</TableCell>
                <TableCell>Replays</TableCell>
                <TableCell>P1</TableCell>
                <TableCell>P2</TableCell>
                <TableCell style={{ whiteSpace: 'nowrap' }}>
                  Ports changed
                </TableCell>
                <TableCell style={{ whiteSpace: 'nowrap' }}>
                  Game started
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {fleet.beamers.map((beamer) => {
                const ports = [...(beamer.game?.ports ?? [])].sort(
                  (a, b) => a.port - b.port,
                );
                let subscribeIcon = (
                  <NotificationsNone color="action" fontSize="small" />
                );
                if (subscribing === beamerKey(beamer)) {
                  subscribeIcon = <CircularProgress size="20px" />;
                } else if (beamer.subscribed) {
                  subscribeIcon = (
                    <NotificationsActive color="action" fontSize="small" />
                  );
                }
                const beamerDetail = beamer.beamerId || beamer.host;
                const beamerTitle = beamerDetail
                  ? `${labelFor(beamer)} · ${beamerDetail}`
                  : labelFor(beamer);
                return (
                  <TableRow
                    hover
                    key={beamerKey(beamer)}
                    onClick={() => {
                      if (!busy) {
                        select(beamerKey(beamer));
                      }
                    }}
                    style={{ cursor: busy ? 'default' : 'pointer' }}
                  >
                    <TableCell padding="checkbox">
                      <span>
                        <IconButton
                          disabled={busy || subscribing === beamerKey(beamer)}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleSubscribe(beamer);
                          }}
                          size="small"
                        >
                          {subscribeIcon}
                        </IconButton>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Stack alignItems="center" direction="row" gap="8px">
                        <Tooltip arrow title={beamerTitle}>
                          <Typography
                            noWrap
                            variant="body2"
                            sx={{ maxWidth: 220 }}
                          >
                            {labelFor(beamer)}
                          </Typography>
                        </Tooltip>
                        {copying === beamerKey(beamer) && (
                          <CircularProgress size="16px" />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <LiveLight beamer={beamer} />
                    </TableCell>
                    <TableCell>
                      <Typography
                        color="text.secondary"
                        style={{ whiteSpace: 'nowrap' }}
                        variant="body2"
                      >
                        {formatReplays(beamer)}
                      </Typography>
                    </TableCell>
                    <PortCell game={beamer.game} port={ports[0]} />
                    <PortCell game={beamer.game} port={ports[1]} />
                    <TableCell>
                      <Typography
                        color="text.secondary"
                        style={{ whiteSpace: 'nowrap' }}
                        variant="body2"
                      >
                        {formatSecs(
                          liveSecs(
                            beamerKey(beamer),
                            beamer.secsSincePortChange,
                          ),
                        )}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        color="text.secondary"
                        style={{ whiteSpace: 'nowrap' }}
                        variant="body2"
                      >
                        {formatSecs(
                          liveSecs(
                            beamerKey(beamer),
                            beamer.secsSinceGameStart,
                          ),
                        )}
                      </Typography>
                    </TableCell>
                    <TableCell padding="none">
                      <Tooltip arrow title="Re-run this beamer's status check">
                        <span>
                          <IconButton
                            disabled={
                              busy || Boolean(refreshing) || Boolean(resetting)
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              refresh(beamerKey(beamer));
                            }}
                          >
                            {refreshing === beamerKey(beamer) ? (
                              <CircularProgress size="24px" />
                            ) : (
                              <Refresh />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell padding="none">
                      <Tooltip arrow title="Erase this beamer's replays">
                        <span>
                          <IconButton
                            disabled={busy || Boolean(resetting)}
                            onClick={(event) => {
                              event.stopPropagation();
                              setConfirmingReset(beamer);
                            }}
                          >
                            {resetting === beamerKey(beamer) ? (
                              <CircularProgress size="24px" />
                            ) : (
                              <DeleteForever color="error" />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <Alert severity="info" style={{ marginTop: '8px' }}>
            {fleet.browsing
              ? 'Listening for Beamers. A beamer appears here within a second or two of joining the network.'
              : 'Not listening yet.'}
          </Alert>
        )}
        {fleet.error && (
          <Alert severity="warning" style={{ marginTop: '8px' }}>
            {`Could not listen for Beamers: ${fleet.error}`}
          </Alert>
        )}
        {error && (
          <Alert
            severity="error"
            style={{ marginTop: '8px', whiteSpace: 'pre-line' }}
          >
            {error}
          </Alert>
        )}
      </DialogContent>
      <Dialog
        open={Boolean(confirmingReset)}
        onClose={() => {
          if (!resetting) {
            setConfirmingReset(null);
          }
        }}
      >
        <DialogTitle>
          {confirmingReset === 'all'
            ? `Erase all ${fleet.beamers.length} beamers?`
            : `Erase ${
                confirmingReset ? labelFor(confirmingReset) : 'beamer'
              }?`}
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning">
            {confirmingReset === 'all'
              ? `Every replay on all ${fleet.beamers.length} of these drives will be erased. This cannot be undone.`
              : confirmingResetCount}
          </Alert>
          {confirmingReset === 'all' && (
            <DialogContentText marginTop="8px" variant="body2">
              {fleet.beamers.map((beamer) => labelFor(beamer)).join(', ')}
            </DialogContentText>
          )}
          <DialogContentText marginTop="8px" variant="body2">
            Anything already copied to this computer is kept. If a game is being
            played right now, let it finish first — the beamer has nowhere to
            put a replay it is midway through writing.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            disabled={Boolean(resetting)}
            onClick={() => setConfirmingReset(null)}
          >
            Cancel
          </Button>
          <Button
            color="error"
            disabled={Boolean(resetting)}
            endIcon={
              resetting ? <CircularProgress size="24px" /> : <DeleteForever />
            }
            onClick={() => {
              if (confirmingReset === 'all') {
                resetAll();
              } else if (confirmingReset) {
                reset(confirmingReset);
              }
            }}
            variant="contained"
          >
            {confirmingReset === 'all' ? 'Erase all' : 'Erase'}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
