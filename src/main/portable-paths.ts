import path from 'path';
import { app } from 'electron';

const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDir) {
  app.setPath('userData', path.join(portableDir, 'data'));
}
