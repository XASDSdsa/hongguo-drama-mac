import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('structure_runner', Path(__file__).resolve().parents[1] / 'src/native/video-structure/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class PunctuationTests(unittest.TestCase):
    def apply(self, texts, restored):
        class Model:
            def add_punctuation(self, text):
                return restored
        rows = [dict(text=text, start_sample=i*32000, end_sample_exclusive=(i+1)*32000) for i, text in enumerate(texts)]
        return runner.punctuate_segments(rows, Model()), rows

    def test_context_preserves_pause_inside_sentence(self):
        result, original = self.apply(['如果明天', '有空就过来下一句'], '如果明天有空，就过来。下一句。')
        self.assertEqual([r['text'] for r in result], ['如果明天', '有空，就过来。下一句。'])
        self.assertEqual([r['start_sample'] for r in result], [r['start_sample'] for r in original])
        self.assertEqual(original[0]['text'], '如果明天')

    def test_punctuation_at_original_boundary_belongs_to_previous(self):
        result, _ = self.apply(['回来', '好的'], '回来！好的。')
        self.assertEqual([r['text'] for r in result], ['回来！', '好的。'])

    def test_changed_words_or_omission_reject(self):
        for restored in ['错误。下一句。', '第一句。', '第一句。下一句。额外。']:
            with self.assertRaises(ValueError): self.apply(['第一句', '下一句'], restored)

    def test_decimal_and_empty(self):
        result, _ = self.apply(['价格3.14元', '谢谢'], '价格3.14元。谢谢！')
        self.assertEqual(result[0]['text'], '价格3.14元。')
        self.assertEqual(self.apply([], '')[0], [])

    def test_truncated_global_recovers_each_vad_without_losing_text(self):
        target = '是他们逼出来的不是你欠我的别去索了啊二爷受罪二爷饶命'
        tail = '我还有一件更大的赏赐是'
        punctuated = '是他们逼出来的，不是你欠我的，别去索了啊，二爷受罪，二爷饶命。'
        class Model:
            def add_punctuation(self, text):
                return {target + ' ' + tail: punctuated, target: punctuated,
                        tail: '我还有一件更大的赏赐，是。'}[text]
        rows = [dict(text=target, start=14.406, end=21.676), dict(text=tail, start=60, end=63)]
        result, source, warnings = runner.restore_punctuation(rows, Model())
        self.assertEqual([row['text'] for row in result], [punctuated, '我还有一件更大的赏赐，是。'])
        self.assertEqual([(row['start'], row['end']) for row in result], [(14.406, 21.676), (60, 63)])
        self.assertEqual(rows[0]['text'], target)
        self.assertEqual(source, 'ct_transformer_vad')
        self.assertEqual([warning['code'] for warning in warnings], ['punctuation_global_fallback'])

    def test_failed_vad_keeps_original_without_discarding_other_vads(self):
        class Model:
            def add_punctuation(self, text):
                return {'第一句 下一句': '第一句。', '第一句': '第一句！', '下一句': '错误。'}[text]
        rows = [dict(text='第一句', start=0, end=1), dict(text='下一句', start=2, end=3)]
        result, source, warnings = runner.restore_punctuation(rows, Model())
        self.assertEqual([row['text'] for row in result], ['第一句！', '下一句'])
        self.assertEqual(source, 'ct_transformer_vad')
        self.assertEqual(warnings[-1]['code'], 'punctuation_unresolved')
        self.assertEqual(warnings[-1]['segment_index'], 1)
        self.assertEqual((warnings[-1]['start'], warnings[-1]['end']), (2, 3))

    def test_valid_global_does_not_repunctuate_vad_as_sentences(self):
        class Model:
            calls = 0
            def add_punctuation(self, text):
                self.calls += 1
                return '如果明天有空，就过来。'
        model = Model()
        result, source, warnings = runner.restore_punctuation([dict(text='如果明天'), dict(text='有空就过来')], model)
        self.assertEqual([row['text'] for row in result], ['如果明天', '有空，就过来。'])
        self.assertEqual(model.calls, 1)
        self.assertEqual(source, 'ct_transformer_global')
        self.assertEqual(warnings, [])

if __name__ == '__main__': unittest.main()
