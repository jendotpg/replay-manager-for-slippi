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
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { DeleteForever, Refresh, Warning } from '@mui/icons-material';
import { FormEvent, useEffect, useState } from 'react';
import { BeamerGame, BeamerStation } from '../common/types';
import { EMPTY_BEAMER_FLEET, characterNames } from '../common/constants';
import getCharacterIcon from './getCharacterIcon';

function labelFor(station: BeamerStation) {
  return station.stationName || station.stationId || station.address;
}

function healthIconFor(station: BeamerStation) {
  if (station.health !== 'warn' && station.health !== 'error') {
    return null;
  }
  const title =
    station.warnings.length > 0
      ? station.warnings.join(', ')
      : "ERROR. Check Beamer.";
  return (
    <Tooltip arrow title={title}>
      <Warning
        color={station.health === 'error' ? 'error' : 'warning'}
        fontSize="small"
      />
    </Tooltip>
  );
}

function secondaryFor(station: BeamerStation) {
  const parts = [station.address];
  if (station.replayCount >= 0) {
    parts.push(
      station.replayCap >= 0
        ? `${station.replayCount}/${station.replayCap} replays`
        : `${station.replayCount} replays`,
    );
  }
  if (station.ssid) {
    parts.push(station.ssid);
  }
  return parts.join(' · ');
}

function GamePorts({ game }: { game: BeamerGame }) {
  if (game.ports.length === 0) {
    return null;
  }
  return (
    <Stack gap="4px" marginTop="4px">
      <Typography color="text.secondary" variant="caption">
        {game.live ? 'Game in progress' : 'Last game'}
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap="4px">
        {game.ports.map((port) => (
          <Chip
            key={port.port}
            icon={
              <Avatar
                alt={
                  port.charId === null
                    ? port.char
                    : characterNames.get(port.charId)
                }
                src={getCharacterIcon(port.charId ?? 31, port.costume)}
                style={{ height: '24px', width: '24px' }}
                variant="square"
              />
            }
            label={port.nametag || `P${port.port}`}
            size="small"
            variant="outlined"
          />
        ))}
      </Stack>
    </Stack>
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
  const [addressOrHost, setAddressOrHost] = useState('');
  const [copying, setCopying] = useState('');
  const [refreshing, setRefreshing] = useState('');
  const [confirmingReset, setConfirmingReset] = useState<
    BeamerStation | 'all' | null
  >(null);
  const [resetting, setResetting] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    window.electron.onBeamerFleet((_event, newFleet) => {
      setFleet(newFleet);
    });
  }, []);

  useEffect(() => {
    if (!open) {
      window.electron.stopBeamerBrowse();
      return;
    }

    setError('');
    (async () => {
      const rememberedPromise = window.electron.getBeamerAddress();
      const fleetPromise = window.electron.getBeamerFleet();
      setAddressOrHost(await rememberedPromise);
      setFleet(await fleetPromise);
      await window.electron.startBeamerBrowse();
    })();
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

  const copyOnSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!addressOrHost) {
      return;
    }
    await select(addressOrHost);
  };

  const busy = Boolean(copying);

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
          Beamers
          {fleet.stations.length > 0 && (
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
          )}
        </Stack>
      </DialogTitle>
      <DialogContent>
        {fleet.stations.length > 0 ? (
          <List dense>
            {fleet.stations.map((station) => (
              <ListItemButton
                alignItems="flex-start"
                disabled={busy}
                key={station.address}
                onClick={() => {
                  select(station.address);
                }}
              >
                <ListItemText
                  disableTypography
                  primary={
                    <Stack alignItems="center" direction="row" gap="8px">
                      <Tooltip arrow title={station.stationId || station.host}>
                        <Typography variant="body2">
                          {labelFor(station)}
                        </Typography>
                      </Tooltip>
                      {healthIconFor(station)}
                    </Stack>
                  }
                  secondary={
                    <>
                      <Typography color="text.secondary" variant="caption">
                        {secondaryFor(station)}
                      </Typography>
                      {station.game && <GamePorts game={station.game} />}
                    </>
                  }
                />
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
                {copying === station.address && (
                  <CircularProgress size="24px" />
                )}
              </ListItemButton>
            ))}
          </List>
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
        <Divider style={{ marginTop: '16px' }} />
        <DialogContentText marginTop="8px" variant="body2">
          Or type the station&apos;s IP address, or its hostname if you know it.
        </DialogContentText>
        <form onSubmit={copyOnSubmit}>
          <Stack alignItems="center" direction="row" gap="8px" marginTop="8px">
            <TextField
              fullWidth
              disabled={busy}
              label="Beamer address"
              onChange={(event) => {
                setAddressOrHost(event.target.value);
              }}
              placeholder="192.168.1.42"
              size="small"
              value={addressOrHost}
              variant="standard"
            />
            <Button
              disabled={!addressOrHost || busy}
              endIcon={
                copying === addressOrHost ? (
                  <CircularProgress size="24px" />
                ) : undefined
              }
              type="submit"
              variant="contained"
            >
              Select
            </Button>
          </Stack>
        </form>
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
