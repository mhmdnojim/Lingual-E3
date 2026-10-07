"""Convert the course videos (FLV: VP6 + MP3, unplayable in browsers) to MP4 (H.264 + AAC).

Writes web/data/video/<VI-id>/<name>.mp4. Needs ffmpeg: `pip install imageio-ffmpeg`.
"""
import glob
import os
import subprocess
import sys

import imageio_ffmpeg

from common import DATA, SHARED


def main():
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    sources = sorted(glob.glob(os.path.join(SHARED, 'assets', 'video', '*', '*.flv')))
    failed = []
    for i, src in enumerate(sources, 1):
        vid = os.path.basename(os.path.dirname(src))
        name = os.path.splitext(os.path.basename(src))[0]
        out = os.path.join(DATA, 'video', vid, name + '.mp4')
        if os.path.exists(out):
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tmp = out + '.part.mp4'
        cmd = [ffmpeg, '-y', '-loglevel', 'error', '-i', src,
               '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
               '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            os.replace(tmp, out)
            print(f'[{i}/{len(sources)}] {name}', flush=True)
        else:
            failed.append(name)
            print(f'[{i}/{len(sources)}] FAILED {name}: {r.stderr.strip()[:300]}', flush=True)
            if os.path.exists(tmp):
                os.remove(tmp)
    print(f'done, {len(failed)} failed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
