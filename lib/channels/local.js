/**
 * dsh-notify-hub native desktop channel.
 *
 * Windows uses a real toast, with the AppUserModelId registered on first use and
 * a NotifyIcon balloon as the fail-safe fallback; macOS uses `osascript`;
 * Linux uses `notify-send`. Ported from dsh-notify-center, which is the only
 * reference implementation that works with the browser closed on all three
 * platforms.
 *
 * @module dsh-notify-hub/channels/local
 */

import { spawn } from 'node:child_process'
import { renderLocal } from '../render.js'
import { ChannelError, ERROR_CODES } from './http.js'

/** AppUserModelId the toast is attributed to. */
const APP_ID = 'DeepSeekHarness.NotifyHub'

/**
 * Compatibility status of the native channel on one platform.
 * @param {NodeJS.Platform} [platform] - defaults to the current platform.
 * @returns {{ supported: boolean, backend: string }} support info.
 */
export function localSupport(platform = process.platform) {
  if (platform === 'win32') return { supported: true, backend: 'windows-toast' }
  if (platform === 'darwin') return { supported: true, backend: 'osascript' }
  if (platform === 'linux') return { supported: true, backend: 'notify-send' }
  return { supported: false, backend: 'unsupported' }
}

/** PowerShell source that stamps an AppUserModelId onto a shortcut. */
const AUMID_SETTER_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;

public static class DshNotifyHubAumid {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT {
        public ushort vt;
        public ushort wReserved1, wReserved2, wReserved3;
        public IntPtr pValue;
        public IntPtr pValue2;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }

    const ushort VT_LPWSTR = 31;
    const int GPS_READWRITE = 0x2;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetPropertyStoreFromParsingName(
        string pszPath, IntPtr pbc, int flags, ref Guid riid, out IntPtr ppv);

    public static void Set(string shortcutPath, string aumid) {
        Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IntPtr pointer;
        int result = SHGetPropertyStoreFromParsingName(
            shortcutPath, IntPtr.Zero, GPS_READWRITE, ref iid, out pointer);
        if (result != 0) throw new COMException("property store open failed", result);
        IPropertyStore store = (IPropertyStore)Marshal.GetObjectForIUnknown(pointer);
        PROPERTYKEY key = new PROPERTYKEY {
            fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            pid = 5
        };
        PROPVARIANT value = new PROPVARIANT {
            vt = VT_LPWSTR,
            pValue = Marshal.StringToCoTaskMemUni(aumid)
        };
        try {
            store.SetValue(ref key, ref value);
            store.Commit();
        } finally {
            Marshal.FreeCoTaskMem(value.pValue);
            Marshal.Release(pointer);
        }
    }
}
`

function base64Utf8(value) {
  return Buffer.from(value, 'utf8').toString('base64')
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** A toast tag has to survive the WinRT tag charset and length rules. */
function toastTag(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '-').slice(-64)
}

/**
 * Build the PowerShell toast script for one notification. Exported for tests:
 * the script is the only place where user content is interpolated, so its
 * escaping is worth asserting.
 *
 * @param {string} title - notification title.
 * @param {string} body - notification body.
 * @param {string} id - envelope id, used as the toast tag.
 * @param {boolean} sound - whether the toast plays a sound.
 * @returns {string} the script.
 */
export function buildWindowsScript(title, body, id, sound) {
  const title64 = base64Utf8(title)
  const body64 = base64Utf8(body)
  const setter64 = base64Utf8(AUMID_SETTER_SOURCE)
  const tag = toastTag(id)
  const audio = sound ? '' : '<audio silent="true"/>'
  return [
    "$ErrorActionPreference='Stop'",
    `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${title64}'))`,
    `$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body64}'))`,
    `$appId='${APP_ID}'`,
    'try {',
    "  $shortcut=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\dsh-notify-hub.lnk'",
    `  $reg='HKCU:\\Software\\Classes\\AppUserModelId\\${APP_ID}'`,
    '  New-Item -Path $reg -Force | Out-Null',
    "  New-ItemProperty -Path $reg -Name DisplayName -Value 'DeepSeek Harness' -Force | Out-Null",
    '  $registered=(Get-ItemProperty -Path $reg -Name Registered -ErrorAction SilentlyContinue).Registered -eq 1',
    '  if (-not $registered -or -not (Test-Path -LiteralPath $shortcut)) {',
    '    $shell=New-Object -ComObject WScript.Shell',
    '    $link=$shell.CreateShortcut($shortcut)',
    "    $link.TargetPath=Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "    $link.Arguments='-NoProfile -WindowStyle Hidden -Command \\\"exit\\\"'",
    '    $link.WorkingDirectory=$env:WINDIR',
    "    $link.Description='DeepSeek Harness notifications'",
    '    $link.Save()',
    `    $setter=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${setter64}'))`,
    '    Add-Type -TypeDefinition $setter',
    '    [DshNotifyHubAumid]::Set($shortcut,$appId)',
    '    New-ItemProperty -Path $reg -Name Registered -PropertyType DWord -Value 1 -Force | Out-Null',
    '  }',
    '  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null',
    '  $et=[System.Security.SecurityElement]::Escape($t)',
    '  $eb=[System.Security.SecurityElement]::Escape($b)',
    `  $xmlText='<toast><visual><binding template="ToastGeneric"><text>'+$et+'</text><text>'+$eb+'</text></binding></visual>${audio}</toast>'`,
    '  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $xml.LoadXml($xmlText)',
    '  $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)',
    `  $toast.Tag=${psQuote(tag)}`,
    "  $toast.Group='dsh-notify-hub'",
    '  $toast.ExpirationTime=[DateTimeOffset]::Now.AddDays(1)',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
    '  Start-Sleep -Seconds 3',
    '} catch {',
    "  if ($env:DSH_NOTIFY_HUB_DEBUG -eq '1') { Write-Warning ('Toast failed: '+$_.Exception.ToString()) }",
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  Add-Type -AssemblyName System.Drawing',
    '  $icon=New-Object System.Windows.Forms.NotifyIcon',
    '  $icon.Icon=[System.Drawing.SystemIcons]::Information',
    '  $icon.BalloonTipIcon=[System.Windows.Forms.ToolTipIcon]::Info',
    '  $icon.BalloonTipTitle=$t.Substring(0,[Math]::Min($t.Length,63))',
    '  $icon.BalloonTipText=$b.Substring(0,[Math]::Min($b.Length,255))',
    '  $icon.Visible=$true',
    '  $icon.ShowBalloonTip(8000)',
    '  Start-Sleep -Milliseconds 8500',
    '  $icon.Dispose()',
    '}',
  ].join(';')
}

/** Quote one string for an AppleScript literal. */
export function appleScriptQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * The command that shows one notification on `platform`.
 * @param {NodeJS.Platform} platform - target platform.
 * @param {object} envelope - notification envelope.
 * @param {object} settings - resolved hub settings.
 * @returns {{ command: string, args: string[], timeoutMs: number, stdin?: string } | null}
 *   the command, or null when the platform is unsupported.
 */
export function commandForPlatform(platform, envelope, settings) {
  const rendered = renderLocal(envelope, {
    locale: settings.locale ?? 'zh',
    includeSummary: true,
  })
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      timeoutMs: 30_000,
      stdin: buildWindowsScript(rendered.title, rendered.body, envelope.id, settings.local?.sound !== false),
    }
  }
  if (platform === 'darwin') {
    const sound = settings.local?.sound === false ? '' : ' sound name "default"'
    return {
      command: 'osascript',
      args: ['-e', `display notification ${appleScriptQuote(rendered.body)} with title ${appleScriptQuote(rendered.title)}${sound}`],
      timeoutMs: 10_000,
    }
  }
  if (platform === 'linux') {
    return {
      command: 'notify-send',
      args: [
        '-a', 'DeepSeek Harness',
        '-u', envelope.kind === 'error' ? 'critical' : 'normal',
        rendered.title,
        rendered.body,
      ],
      timeoutMs: 10_000,
    }
  }
  return null
}

/** Run one local command to completion, honoring cancellation and timeout. */
function runCommand(command, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ChannelError('local notification cancelled', ERROR_CODES.CANCELLED))
      return
    }
    let settled = false
    const child = spawn(command.command, [...command.args], {
      stdio: [command.stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`local notification timed out after ${command.timeoutMs}ms`))
    }, command.timeoutMs)
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    function onAbort() {
      child.kill()
      finish(new ChannelError('local notification cancelled', ERROR_CODES.CANCELLED))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => finish(new Error(`cannot start ${command.command}: ${error.message}`)))
    child.once('close', (code) => finish(
      code === 0 ? undefined : new Error(`${command.command} exited with code ${code ?? 'unknown'}`),
    ))
    child.stdin?.once('error', (error) => finish(new Error(`cannot write to ${command.command}: ${error.message}`)))
    if (command.stdin !== undefined) child.stdin?.end(command.stdin, 'utf8')
  })
}

/**
 * Show one native desktop notification.
 * @param {object} envelope - notification envelope.
 * @param {object} settings - resolved hub settings.
 * @param {object} [options] - signal and platform overrides.
 * @returns {Promise<{ backend: string }>} the backend that ran.
 * @throws {ChannelError} when the platform is unsupported or the command fails.
 */
export async function sendLocalNotification(envelope, settings, options = {}) {
  const platform = options.platform ?? process.platform
  const support = localSupport(platform)
  if (!support.supported) {
    throw new ChannelError(`当前平台（${platform}）不支持桌面通知`, ERROR_CODES.NOT_CONFIGURED)
  }
  const command = commandForPlatform(platform, envelope, settings)
  if (command === null) {
    throw new ChannelError(`当前平台（${platform}）不支持桌面通知`, ERROR_CODES.NOT_CONFIGURED)
  }
  await runCommand(command, options.signal)
  return { backend: support.backend }
}
