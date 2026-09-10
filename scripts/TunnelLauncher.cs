using System;
using System.Diagnostics;
using System.IO;

internal static class TunnelLauncher
{
    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "scripts", "start-tunnel.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("Keep this EXE in the repository root alongside scripts/start-tunnel.ps1.");
            string option = "";
            foreach (string arg in args)
            {
                if (arg == "--reset-key") option += " -ResetKey";
                else if (arg == "--check") option += " -CheckOnly";
                else throw new ArgumentException("Supported options: --reset-key, --check");
            }
            string shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            var start = new ProcessStartInfo(shell, "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"" + option);
            start.UseShellExecute = false;
            start.WorkingDirectory = root;
            using (var process = Process.Start(start))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
