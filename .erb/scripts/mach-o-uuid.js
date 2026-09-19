const { exec, execFile } = require('child_process');
const { PythonShell } = require('python-shell');

const DEFAULT_PYTHON_PATH = 'python3';

function checkMacholib(pythonPath) {
  return new Promise((resolve, reject) => {
    execFile(pythonPath, ['-c', 'import macholib'], (error) => {
      if (!error) {
        resolve();
        return;
      }

      const problem =
        error.code === 'ENOENT'
          ? `\`${pythonPath}\` was not found on PATH.`
          : `\`${pythonPath}\` cannot import the \`macholib\` package.`;
      reject(
        new Error(
          `mach-o-uuid afterPack hook: ${problem}\n` +
            `Packaging on macOS needs Python 3 with macholib installed. Either:\n` +
            `  - run \`python3 -m pip install macholib\` (add \`--user\`, or use a venv, if pip\n` +
            `    refuses with "externally-managed-environment"), or\n` +
            `  - set PYTHON_PATH to an interpreter that already has macholib, e.g.\n` +
            `    \`PYTHON_PATH=/path/to/venv/bin/python npm run package\`.`,
        ),
      );
    });
  });
}

exports.default = async function machOUuid(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin' || context.arch !== 4) {
    return;
  }

  const pythonPath = process.env.PYTHON_PATH || DEFAULT_PYTHON_PATH;
  await checkMacholib(pythonPath);

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const executablePath = `${appPath}/Contents/MacOS/${appName}`;
  const results = await PythonShell.run(`${__dirname}/mach-o-uuid.py`, {
    pythonPath,
    args: [executablePath],
  });
  console.log(results.join('\n'));

  await new Promise((resolve, reject) => {
    exec(`codesign --deep -s - "${appPath}"`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};
