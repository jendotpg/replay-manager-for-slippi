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
  Refresh,
  Warning,
} from '@mui/icons-material';
import { useEffect, useRef, useState } from 'react';
import { BeamerGame, BeamerPort, BeamerStation } from '../common/types';
import { EMPTY_BEAMER_FLEET, characterNames } from '../common/constants';
import getCharacterIcon from './getCharacterIcon';

function labelFor(station: BeamerStation) {
  return station.stationName || station.stationId || station.address;
}

function warningsFor(station: BeamerStation) {
  return station.warnings.join(', ');
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

function formatReplays(station: BeamerStation) {
  if (station.replayCount < 0) {
    return '\u2014';
  }
  return station.replayCap >= 0
    ? `${station.replayCount} / ${station.replayCap}`
    : `${station.replayCount}`;
}

function StationsTooltip({
  showWarnings,
  stations,
}: {
  showWarnings: boolean;
  stations: BeamerStation[];
}) {
  return (
    <Stack gap="2px">
      {stations.map((station) => {
        const warnings = showWarnings ? warningsFor(station) : '';
        return (
          <Typography key={station.address} variant="caption">
            {warnings
              ? `${labelFor(station)} — ${warnings}`
              : labelFor(station)}
          </Typography>
        );
      })}
    </Stack>
  );
}

function HealthIcon({ station }: { station: BeamerStation }) {
  if (station.health !== 'warn' && station.health !== 'error') {
    return null;
  }
  const icon =
    station.health === 'error' ? (
      <ErrorOutline color="error" fontSize="small" />
    ) : (
      <Warning color="warning" fontSize="small" />
    );
  const warnings = warningsFor(station);
  const title = warnings || (station.health === 'error' ? 'ERROR' : '');
  return title ? (
    <Tooltip arrow title={title}>
      {icon}
    </Tooltip>
  ) : (
    icon
  );
}

const LIVE_DOT = {
  live: { color: '#31d158', title: 'Game in progress' },
  idle: { color: '#14532d', title: 'No game in progress' },
  down: { color: '#f04438', title: 'ERROR' },
};

const MAX_GAMES_FROM_INDEX = 16; // NUM-REPLAYS-SERVED ceiling

const DOWN_WARNINGS = ['DRIVE FULL', 'NO WII']; // udate if more "can't write" warnings are added...

function LiveDot({ station }: { station: BeamerStation }) {
  const down = station.warnings.filter((warning) =>
    DOWN_WARNINGS.includes(warning),
  );
  let state: keyof typeof LIVE_DOT = 'idle';
  if (station.health === 'error' || down.length > 0) {
    state = 'down';
  } else if (station.game?.live) {
    state = 'live';
  }
  const { color } = LIVE_DOT[state];
  const dot = (
    <span
      style={{
        backgroundColor: color,
        borderRadius: '50%',
        boxShadow: state === 'idle' ? 'none' : `0 0 6px ${color}`,
        display: 'inline-block',
        height: '10px',
        width: '10px',
      }}
    />
  );
  if (state !== 'down') {
    return dot;
  }
  const title =
    station.health === 'error'
      ? warningsFor(station) || LIVE_DOT.down.title
      : down.join(', ');
  return (
    <Tooltip arrow title={title}>
      {dot}
    </Tooltip>
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
  const [confirmingReset, setConfirmingReset] = useState<
    BeamerStation | 'all' | null
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

  const select = async (address: string) => {
    setCopying(address);
    setError('');
    try {
      await window.electron.copyFromBeamer(address);
      onClose();
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setCopying('');
    }
  };

  const refresh = async (address: string) => {
    setRefreshing(address);
    setError('');
    try {
      await window.electron.refreshBeamerStatus(address);
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setRefreshing('');
    }
  };

  const refreshAll = async () => {
    setRefreshing('all');
    setError('');
    try {
      const failures = await window.electron.refreshAllBeamerStations();
      if (failures.length > 0) {
        setError(`Refreshed the rest, but not these:\n${failures.join('\n')}`);
      }
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setRefreshing('');
    }
  };

  const reset = async (station: BeamerStation) => {
    setResetting(station.address);
    setError('');
    try {
      await window.electron.resetBeamerStation(station.address);
      setConfirmingReset(null);
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setResetting('');
    }
  };

  const resetAll = async () => {
    setResetting('all');
    setError('');
    try {
      const failures = await window.electron.resetAllBeamerStations();
      if (failures.length === 0) {
        setConfirmingReset(null);
        return;
      }
      setError(`Erased the rest, but not these:\n${failures.join('\n')}`);
    } catch (e: any) {
      setError(e instanceof Error ? e.message : e);
    } finally {
      setResetting('');
    }
  };

  const busy = Boolean(copying);
  const erroring = fleet.stations.filter(
    (station) => station.health === 'error',
  );
  const warning = fleet.stations.filter((station) => station.health === 'warn');

  let confirmingResetCount =
    "Every replay on this station's drive will be erased. This cannot be undone.";
  if (
    confirmingReset &&
    confirmingReset !== 'all' &&
    confirmingReset.replayCount >= 0
  ) {
    confirmingResetCount = `All ${confirmingReset.replayCount} replays on this station's drive will be erased. This cannot be undone.`;
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
                  <StationsTooltip showWarnings={false} stations={erroring} />
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
                title={<StationsTooltip showWarnings stations={warning} />}
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
          {fleet.stations.length > 0 && (
            <Stack alignItems="center" direction="row" gap="4px">
              <Tooltip
                arrow
                title="Re-run the status check on every station listed here"
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
                title="Erase the replays on every station listed here"
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
        {fleet.stations.length > 0 ? (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell />
                <TableCell>Station</TableCell>
                <TableCell>Live</TableCell>
                <TableCell>Replays</TableCell>
                <TableCell>P1</TableCell>
                <TableCell>P2</TableCell>
                <TableCell>Ports changed</TableCell>
                <TableCell>Characters changed</TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {fleet.stations.map((station) => {
                const ports = [...(station.game?.ports ?? [])].sort(
                  (a, b) => a.port - b.port,
                );
                return (
                  <TableRow
                    hover
                    key={station.address}
                    onClick={() => {
                      if (!busy) {
                        select(station.address);
                      }
                    }}
                    style={{ cursor: busy ? 'default' : 'pointer' }}
                  >
                    <TableCell>
                      <HealthIcon station={station} />
                    </TableCell>
                    <TableCell>
                      <Stack alignItems="center" direction="row" gap="8px">
                        <Tooltip
                          arrow
                          title={station.stationId || station.host}
                        >
                          <Typography variant="body2">
                            {labelFor(station)}
                          </Typography>
                        </Tooltip>
                        {copying === station.address && (
                          <CircularProgress size="16px" />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <LiveDot station={station} />
                    </TableCell>
                    <TableCell>
                      <Typography color="text.secondary" variant="body2">
                        {formatReplays(station)}
                      </Typography>
                    </TableCell>
                    <PortCell game={station.game} port={ports[0]} />
                    <PortCell game={station.game} port={ports[1]} />
                    <TableCell>
                      <Typography color="text.secondary" variant="body2">
                        {formatSecs(
                          liveSecs(
                            `${station.address}:ports`,
                            station.secsSincePortChange,
                          ),
                        )}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography color="text.secondary" variant="body2">
                        {formatSecs(
                          liveSecs(
                            `${station.address}:chars`,
                            station.secsSinceCharacterChange,
                          ),
                        )}
                      </Typography>
                    </TableCell>
                    <TableCell padding="none">
                      <Tooltip arrow title="Re-run this station's status check">
                        <span>
                          <IconButton
                            disabled={
                              busy || Boolean(refreshing) || Boolean(resetting)
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              refresh(station.address);
                            }}
                          >
                            {refreshing === station.address ? (
                              <CircularProgress size="24px" />
                            ) : (
                              <Refresh />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell padding="none">
                      <Tooltip arrow title="Erase this station's replays">
                        <span>
                          <IconButton
                            disabled={busy || Boolean(resetting)}
                            onClick={(event) => {
                              event.stopPropagation();
                              setConfirmingReset(station);
                            }}
                          >
                            {resetting === station.address ? (
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
              ? 'Listening for Beamers. A station appears here within a second or two of joining the network.'
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
            ? `Erase all ${fleet.stations.length} stations?`
            : `Erase ${
                confirmingReset ? labelFor(confirmingReset) : 'station'
              }?`}
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning">
            {confirmingReset === 'all'
              ? `Every replay on all ${fleet.stations.length} of these drives will be erased. This cannot be undone.`
              : confirmingResetCount}
          </Alert>
          {confirmingReset === 'all' && (
            <DialogContentText marginTop="8px" variant="body2">
              {fleet.stations.map((station) => labelFor(station)).join(', ')}
            </DialogContentText>
          )}
          <DialogContentText marginTop="8px" variant="body2">
            Anything already copied to this computer is kept. If a game is being
            played right now, let it finish first — the station has nowhere to
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
