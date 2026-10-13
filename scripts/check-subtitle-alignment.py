"""Word alignment output checks; standard library only, no model download."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace as N
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('subtitle_cli', Path(__file__).resolve().parents[1] / 'src/native/faster_whisper_cli.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def segment(start, end, text='完整对白。', words=True):
    return N(start=start - 0.5, end=end + 0.5, text=text,
             words=[N(start=start, end=end)] if words else [])


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.output = Path(self.directory.name) / 'episode.srt'
        self.addCleanup(self.directory.cleanup)

    def test_word_bounds_and_long_video(self):
        cli.write_srt(self.output, [segment(1.123, 2.456), segment(600.1, 600.9, '最后一句。')], 605)
        result = self.output.read_text(encoding='utf-8')
        self.assertIn('00:00:01,123 --> 00:00:02,456', result)
        self.assertIn('00:10:00,100 --> 00:10:00,900', result)
        self.assertIn('完整对白。', result)
        self.assertNotIn('00:10:05,000', result)

    def test_video_end_is_the_limit(self):
        cli.write_srt(self.output, [segment(4, 5.2)], 5)
        self.assertIn('00:00:04,000 --> 00:00:05,000', self.output.read_text(encoding='utf-8'))

    def test_invalid_alignment_never_replaces_valid_output(self):
        self.output.write_text('previous valid file', encoding='utf-8')
        for segments in [[], [segment(1, 2, words=False)], [segment(2, 2)], [segment(1, 3), segment(2, 4)], [segment(float('nan'), 2)], [segment(6, 7)]]:
            with self.subTest(segments=segments), self.assertRaises(RuntimeError):
                cli.write_srt(self.output, segments, 5)
            self.assertEqual(self.output.read_text(encoding='utf-8'), 'previous valid file')


if __name__ == '__main__':
    unittest.main()
