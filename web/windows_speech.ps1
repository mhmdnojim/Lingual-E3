param([ValidateSet('list', 'speak')][string]$Action = 'list')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -AssemblyName System.Speech
    if ($Action -eq 'list') {
        $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $voices = @($speech.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
                @{ id = $_.VoiceInfo.Id; name = $_.VoiceInfo.Name;
                   locale = $_.VoiceInfo.Culture.Name; gender = $_.VoiceInfo.Gender.ToString() }
            })
            @{ voices = $voices } | ConvertTo-Json -Depth 5 -Compress
        } finally { $speech.Dispose() }
    } else {
        # .NET owns the event callback so word timings remain reliable even while
        # synchronous Speak is running on PowerShell's main thread.
        Add-Type -ReferencedAssemblies ([System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location) -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Speech.Synthesis;

public class LinguaSpeechBoundary {
    public double start;
    public string text;
}
public class LinguaSpeechResult {
    public string audio;
    public List<LinguaSpeechBoundary> boundaries = new List<LinguaSpeechBoundary>();
}
public static class LinguaWindowsSpeech {
    public static LinguaSpeechResult Speak(string id, string text, int rate) {
        var result = new LinguaSpeechResult();
        using (var speech = new SpeechSynthesizer())
        using (var output = new MemoryStream()) {
            string name = null;
            foreach (var voice in speech.GetInstalledVoices()) {
                if (voice.Enabled && voice.VoiceInfo.Id == id) name = voice.VoiceInfo.Name;
            }
            if (name == null) throw new InvalidOperationException("This Windows offline voice is no longer installed. Choose an installed Windows voice.");
            speech.SelectVoice(name);
            // Preserve the UI's percentage control with System.Speech's -10..10 scale.
            speech.Rate = Math.Max(-10, Math.Min(10, (int)Math.Round(Math.Log(1 + rate / 100.0, 2) * 10)));
            speech.SpeakProgress += delegate(object sender, SpeakProgressEventArgs e) {
                result.boundaries.Add(new LinguaSpeechBoundary { start = e.AudioPosition.TotalSeconds, text = e.Text });
            };
            speech.SetOutputToWaveStream(output);
            speech.Speak(text);
            speech.SetOutputToNull();
            result.audio = Convert.ToBase64String(output.ToArray());
        }
        return result;
    }
}
'@
        $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
        [LinguaWindowsSpeech]::Speak([string]$request.voice, [string]$request.text, [int]$request.rate) |
            ConvertTo-Json -Depth 5 -Compress
    }
} catch {
    @{ error = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress
    exit 1
}
