import { execa } from 'execa';

/**
 * Encodes a PowerShell script string into Base64 UTF-16LE.
 *
 * @param {string} script
 * @returns {string}
 */
function encodePsScript(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Opens the native Windows File Picker dialog.
 * Returns the selected absolute file path, or null if cancelled.
 *
 * @returns {Promise<string|null>}
 */
export async function openFileDialog() {
    if (process.platform !== 'win32') {
        throw new Error("Native file dialog is currently supported on Windows");
    }

    const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = "MKV Video Files (*.mkv)|*.mkv|All Video Files (*.mkv;*.mp4)|*.mkv;*.mp4|All Files (*.*)|*.*"
$dialog.Title = "Select Video File for Conversion"
$dialog.RestoreDirectory = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.FileName)
}
`;

    try {
        const encoded = encodePsScript(script);
        const { stdout } = await execa('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
            timeout: 300000 // 5-minute timeout for user to pick a file
        });
        const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const selected = lines.length > 0 ? lines[lines.length - 1] : null;
        return selected || null;
    } catch (err) {
        console.error("Error opening Windows file dialog:", err);
        return null;
    }
}

/**
 * Opens the native Windows Folder Picker dialog.
 * Returns the selected absolute folder path, or null if cancelled.
 *
 * @returns {Promise<string|null>}
 */
export async function openFolderDialog() {
    if (process.platform !== 'win32') {
        throw new Error("Native folder dialog is currently supported on Windows");
    }

    const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select Destination Folder for Converted MP4"
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.SelectedPath)
}
`;

    try {
        const encoded = encodePsScript(script);
        const { stdout } = await execa('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
            timeout: 300000
        });
        const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const selected = lines.length > 0 ? lines[lines.length - 1] : null;
        return selected || null;
    } catch (err) {
        console.error("Error opening Windows folder dialog:", err);
        return null;
    }
}
