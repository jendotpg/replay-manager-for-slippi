import {
  Button,
  Stack,
  Typography,
  LinearProgress,
  Box,
  Snackbar,
  Paper,
} from '@mui/material';

import { DownloadStatus } from '../common/types';

const MAX_VISIBLE_SOURCES = 3;

function LinearProgressWithLabel({ value }: { value: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', width: 300 }}>
      <Box sx={{ width: '100%', mr: 1 }}>
        <LinearProgress variant="determinate" value={value} />
      </Box>
      <Box sx={{ minWidth: 35 }}>
        <Typography variant="body2" color="text.secondary">{`${Math.round(
          value,
        )}%`}</Typography>
      </Box>
    </Box>
  );
}

export default function BeamerDownloadSnackbar({
  status,
  onClose,
  onCancel,
}: {
  status: DownloadStatus;
  onClose: () => void;
  onCancel: () => void;
}) {
  const open =
    status.status === 'downloading' ||
    status.status === 'cancelled' ||
    status.status === 'error';

  let content = null;
  if (status.status === 'downloading') {
    const { filesDone, totalFiles, attempt } = status;
    const names = status.sources ?? [];
    const visible = names.slice(0, MAX_VISIBLE_SOURCES).join(', ');
    const overflow = names.length - MAX_VISIBLE_SOURCES;
    const counted =
      totalFiles === undefined || filesDone === undefined
        ? ''
        : ` (${Math.min(filesDone + 1, totalFiles)} of ${totalFiles})`;
    content = (
      <Stack gap={1}>
        <Typography variant="subtitle2">Downloading SLP files...</Typography>
        <LinearProgressWithLabel value={status.progress} />
        <Typography variant="body2" color="text.secondary">
          {visible || status.currentFile}
          {overflow > 0 && (
            <Typography component="span" variant="body2" color="text.disabled">
              {` + ${overflow} more`}
            </Typography>
          )}
          {counted}
        </Typography>
        {attempt !== undefined && attempt > 1 && (
          <Typography variant="body2" color="text.secondary">
            {`Connection dropped, retrying (attempt ${attempt})...`}
          </Typography>
        )}
        <Stack direction="row" justifyContent="flex-end">
          <Button size="small" onClick={onCancel}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    );
  } else if (status.status === 'cancelled') {
    content = (
      <Stack gap={1}>
        <Typography variant="subtitle2">Download Cancelled</Typography>
        <Typography variant="body2" color="text.secondary">
          {`Stopped after ${status.filesDone} of ${status.totalFiles} files. ` +
            'Partly downloaded files are kept, so refreshing picks up where ' +
            'this left off.'}
        </Typography>
        <Stack direction="row" justifyContent="flex-end">
          <Button size="small" onClick={onClose}>
            Close
          </Button>
        </Stack>
      </Stack>
    );
  } else if (status.status === 'error') {
    content = (
      <Stack gap={1}>
        <Typography variant="subtitle2">Error Downloading SLP Files</Typography>
        <Typography variant="body2" color="text.secondary">
          Failed to download the following SLP files:
        </Typography>
        {status.failedFiles.map((file) => (
          <Typography key={file} variant="body2" color="text.secondary">
            {file}
          </Typography>
        ))}
        <Stack direction="row" justifyContent="flex-end">
          <Button size="small" onClick={onClose}>
            Close
          </Button>
        </Stack>
      </Stack>
    );
  }

  return (
    <Snackbar
      open={open}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      onClose={(event, reason) => {
        if (reason === 'clickaway' || status.status === 'downloading') {
          return; // not dismissable - click the cancel button...
        }
        onClose();
      }}
      sx={{
        left: 8,
        bottom: 8,
        right: 'auto',
        maxWidth: 'calc(100vw - 340px)',
      }}
    >
      <Paper elevation={6} sx={{ p: 2, width: 440, maxWidth: '100%' }}>
        {content}
      </Paper>
    </Snackbar>
  );
}
