import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Button,
  Stack,
  Typography,
  LinearProgress,
  Box,
} from '@mui/material';

import { SlpDownloadStatus } from '../common/types';

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

export default function SlpDownloadModal({
  status,
  onClose,
  onCancel,
}: {
  status: SlpDownloadStatus;
  onClose: () => void;
  onCancel: () => void;
}) {
  if (status.status === 'downloading') {
    const { filesDone, totalFiles, attempt } = status;
    const counted =
      totalFiles === undefined || filesDone === undefined
        ? ''
        : ` (${Math.min(filesDone + 1, totalFiles)} of ${totalFiles})`;
    return (
      <Dialog open PaperProps={{ sx: { minWidth: 400, textAlign: 'center' } }}>
        <DialogTitle>Downloading SLP files...</DialogTitle>
        <DialogContent>
          <Stack alignItems="center" gap={2}>
            <LinearProgressWithLabel value={status.progress} />
            <Typography variant="body2" color="text.secondary">
              {`Current file: ${status.currentFile}${counted}`}
            </Typography>
            {attempt !== undefined && attempt > 1 && (
              <Typography variant="body2" color="text.secondary">
                {`Connection dropped, retrying (attempt ${attempt})...`}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel}>Cancel</Button>
        </DialogActions>
      </Dialog>
    );
  }
  if (status.status === 'cancelled') {
    return (
      <Dialog open onClose={onClose}>
        <DialogTitle>Download Cancelled</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {`Stopped after ${status.filesDone} of ${status.totalFiles} files. ` +
              'Partly downloaded files are kept, so refreshing picks up where ' +
              'this left off.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
    );
  }
  if (status.status === 'error') {
    return (
      <Dialog open onClose={onClose}>
        <DialogTitle>Error Downloading SLP Files</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Failed to download the following SLP files:
          </DialogContentText>
          {status.failedFiles.map((file) => (
            <DialogContentText key={file}>{file}</DialogContentText>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
    );
  }
  return null;
}
