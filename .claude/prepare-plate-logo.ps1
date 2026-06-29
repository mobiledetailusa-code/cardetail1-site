# Convert assets/cardetail1-logo.webp to assets/plate-cover-logo.png (System.Drawing)
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$webp = Join-Path $root 'assets\cardetail1-logo.webp'
$png = Join-Path $root 'assets\plate-cover-logo.png'

if (-not (Test-Path $webp)) {
    throw "Missing $webp"
}

if (-not ('ShellThumb' -as [type])) {
    Add-Type @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public class ShellThumb {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItemImageFactory factory);

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItemImageFactory {
        void GetImage(SIZE size, int flags, out IntPtr phbm);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx, cy; }

    public static void Extract(string path, string outPath, int w, int h) {
        Guid guid = typeof(IShellItemImageFactory).GUID;
        IShellItemImageFactory factory;
        int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref guid, out factory);
        if (hr != 0) throw new Exception("SHCreateItemFromParsingName failed: " + hr);
        SIZE size = new SIZE { cx = w, cy = h };
        IntPtr hBitmap;
        factory.GetImage(size, 0x00000001, out hBitmap);
        using (Bitmap bmp = Image.FromHbitmap(hBitmap)) {
            DeleteObject(hBitmap);
            bmp.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
        }
    }

    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);
}
"@ -ReferencedAssemblies System.Drawing
}

[ShellThumb]::Extract($webp, $png, 1040, 520)
Write-Host "Wrote $png"
