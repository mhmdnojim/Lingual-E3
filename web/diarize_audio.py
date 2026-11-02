"""Run local pyannote speaker diarization and emit timed A/B/Explanation turns as JSON."""
import json
import sys
from pathlib import Path

import numpy as np
import torch
from pyannote.audio import Pipeline


MODEL = Path(__file__).resolve().parent / 'vendor' / 'models' / 'speaker-diarization-community-1'
pipeline = Pipeline.from_pretrained(str(MODEL))
audio = np.frombuffer(sys.stdin.buffer.read(), dtype=np.float32).copy()
waveform = torch.from_numpy(audio).unsqueeze(0)
output = pipeline({'waveform': waveform, 'sample_rate': 16000}, min_speakers=2, max_speakers=3)
annotation = output.speaker_diarization
raw_turns = [(turn.start, turn.end, speaker)
             for turn, _, speaker in annotation.itertracks(yield_label=True)]

# Stable role names follow order of appearance. A third distinct voice is treated as explanation.
ordered = sorted({speaker: min(start for start, _, who in raw_turns if who == speaker)
                  for _, _, speaker in raw_turns}.items(), key=lambda item: item[1])
roles = {speaker: ('A' if i == 0 else 'B' if i == 1 else 'explanation')
         for i, (speaker, _) in enumerate(ordered)}
turns = [{'start': start, 'end': end, 'speaker': roles[speaker]}
         for start, end, speaker in raw_turns]
print(json.dumps(turns, separators=(',', ':')))
