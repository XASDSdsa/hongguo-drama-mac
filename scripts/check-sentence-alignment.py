"""Acoustic cut regressions with controlled PCM/VAD, without model downloads."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sentence_alignment', Path(__file__).resolve().parents[1] / 'src/native/sentence_alignment.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RATE = 16000


def word(text, start, end, probability=.8):
    return dict(word=text, start=start, end=end, probability=probability)


def source(text='第一句。第二句！', start=0, duration=4):
    return dict(start_sample=round(start * RATE), end_sample_exclusive=round((start + duration) * RATE),
                start=start, end=start + duration, text=text)


def evidence(audio, spans):
    return module.acoustic_evidence(audio, detector=lambda _: [dict(start=round(a * RATE), end=round(b * RATE)) for a, b in spans])


def pcm(duration, gaps=(), volume=.2):
    import numpy as np
    # Continuous modulated tone is synthetic input, not claimed as actual speech.
    t=np.arange(round(duration * RATE), dtype=np.float64) / RATE
    audio=(volume * (.75 + .25 * np.cos(2 * np.pi * 3 * t)) * np.sin(2 * np.pi * 180 * t)).astype(np.float32)
    for a, b in gaps:
        audio[round(a * RATE):round(b * RATE)]=0
    return audio


class AudioCutTests(unittest.TestCase):
    def test_wrong_punctuation_never_cuts_continuous_audio(self):
        audio=pcm(3)
        text='突破汉月。五、品，继续！'
        words=[word('突破汉月',0,1.5),word('五',1.5,1.9),word('品',1.9,2.2),word('继续',2.2,3)]
        rows, warning=module.align_segment(source(text,duration=3),words,'one',evidence(audio,[(0,3)]))
        self.assertEqual([r['text'] for r in rows],[text])
        self.assertEqual(len(rows[0]['speech_spans']),1)
        self.assertIsNone(warning)

    def test_fake_word_timestamp_gap_cannot_cut_audible_speech(self):
        audio=pcm(4)
        rows,_=module.align_segment(source(),[word('第一句',0,1),word('第二句',2,4)],'one',evidence(audio,[(0,4)]))
        self.assertEqual(len(rows),1)
        self.assertEqual((rows[0]['start'],rows[0]['end']),(0,4))

    def test_no_audio_evidence_cannot_cut_by_text_or_word_gap(self):
        rows,_=module.align_segment(source(),[word('第一句',0,1),word('第二句',2,4)],'one')
        self.assertEqual(len(rows),1)

    def test_late_word_alignment_cannot_trim_audible_edges(self):
        for ev in [None, evidence(pcm(4), []), evidence(pcm(4), [(1,3)])]:
            rows,_=module.align_segment(source(),[word('第一句',.5,1.5),word('第二句',2,3.5)],'one',ev)
            self.assertEqual((rows[0]['start'],rows[0]['end']),(0,4))

    def test_actual_pause_splits_without_punctuation_and_preserves_offset(self):
        audio=pcm(6,[(2.2,2.7)])
        ev=evidence(audio,[(1,2.2),(2.7,5)])
        rows,warning=module.align_segment(source('前一句 后一句',start=1,duration=4),
            [word('前一句',0,1.5),word('后一句',1.5,4)],'source',ev)
        self.assertIsNone(warning)
        self.assertEqual([r['text'] for r in rows],['前一句 ','后一句'])
        self.assertEqual([(r['start'],r['end']) for r in rows],[(1,2.22),(2.68,5)])
        self.assertEqual(''.join(r['text'] for r in rows),'前一句 后一句')
        for row in rows:
            self.assertEqual(row['start_sample'],row['speech_spans'][0]['start_sample'])
            self.assertEqual(row['end_sample_exclusive'],row['speech_spans'][0]['end_sample_exclusive'])

    def noisy(self, duration, gaps, floor=.004):
        import numpy as np
        audio = pcm(duration)
        rng = np.random.default_rng(3)
        for a, b in gaps:
            n = round(b * RATE) - round(a * RATE)
            audio[round(a * RATE):round(b * RATE)] = (rng.standard_normal(n) * floor).astype(np.float32)
        return audio

    def test_breath_with_room_noise_floor_splits_clauses(self):
        # 0.18 s breaths over a noise floor, word times 100 ms off: still three clauses, no punctuation needed.
        audio = self.noisy(6, [(1.9, 2.08), (4.0, 4.18)])
        ev = evidence(audio, [(0, 1.9), (2.08, 4.0), (4.18, 6)])
        self.assertEqual(len(ev['pauses']), 2)
        words = [word('他', 0, .9), word('走了', .9, 1.85), word('可是', 2.2, 3), word('没回头', 3, 3.95),
                 word('我', 4.25, 5), word('等着', 5, 6)]
        rows, warning = module.align_segment(source('他走了可是没回头我等着。', duration=6), words, 's', ev)
        self.assertIsNone(warning)
        self.assertEqual([r['text'] for r in rows], ['他走了', '可是没回头', '我等着。'])
        self.assertEqual(''.join(r['text'] for r in rows), '他走了可是没回头我等着。')
        self.assertTrue(all(len(r['speech_spans']) == 1 for r in rows))
        self.assertGreater(rows[1]['start'] - rows[0]['end'], .1)

    def test_loud_gap_is_not_a_breath(self):
        self.assertFalse(evidence(pcm(4), [(0, 1.5), (1.7, 4)])['pauses'])
        self.assertFalse(evidence(self.noisy(4, [(1.5, 1.7)], floor=.1), [(0, 1.5), (1.7, 4)])['pauses'])

    def test_nearest_word_boundary_is_used_when_two_are_close(self):
        ev = evidence(self.noisy(4, [(1.5, 1.7)]), [(0, 1.5), (1.7, 4)])
        words = [word('甲', 0, .7), word('乙', .7, 1.3), word('丙', 1.75, 2.5), word('丁', 2.5, 4)]
        rows, warning = module.align_segment(source('甲乙丙丁', duration=4), words, 's', ev)
        self.assertIsNone(warning)
        self.assertEqual([r['text'] for r in rows], ['甲乙', '丙丁'])

    def test_quiet_gap_without_vad_confirmation_is_not_cut(self):
        audio=pcm(4,[(1.2,1.8)])
        ev=evidence(audio,[(0,4)])
        self.assertFalse(ev['pauses'])
        rows,_=module.align_segment(source(),[word('第一句',0,1.5),word('第二句',1.5,4)],'source',ev)
        self.assertEqual(len(rows),1)

    def test_vad_misfire_without_quiet_pcm_is_not_cut(self):
        ev=evidence(pcm(4),[(0,1.2),(1.8,4)])
        self.assertFalse(ev['pauses'])

    def test_short_dip_and_soft_voice_are_not_silence(self):
        self.assertFalse(evidence(pcm(4,[(1.2,1.3)]),[(0,1.2),(1.3,4)])['pauses'])
        self.assertFalse(evidence(pcm(4,volume=.001),[(0,1.2),(1.8,4)])['pauses'])

    def test_pause_inside_word_does_not_invent_text_split(self):
        ev=evidence(pcm(4,[(1.2,1.8)]),[(0,1.2),(1.8,4)])
        rows,warning=module.align_segment(source('完整词。'),[word('完整词',0,4)],'one',ev)
        self.assertEqual(len(rows),1)
        self.assertEqual(warning['code'],'acoustic_pause_text_unresolved')

    def test_uncertain_word_alignment_warns_instead_of_cutting(self):
        ev=evidence(pcm(4,[(1.2,1.8)]),[(0,1.2),(1.8,4)])
        rows,warning=module.align_segment(source(),[word('第一句',0,1.5,.001),word('第二句',1.5,4)],'one',ev)
        self.assertEqual(len(rows),1)
        self.assertEqual(warning['code'],'acoustic_pause_text_unresolved')

    def test_zero_tick_does_not_turn_punctuation_into_a_cut(self):
        rows,warning=module.align_segment(source('突破汉月。五、品'),
             [word('突破汉月',0,2),word('五',2,2),word('品',2,4)],'one',evidence(pcm(4),[(0,4)]))
        self.assertEqual(len(rows),1)
        self.assertTrue(rows[0]['needs_review'])

    def test_bad_timing_and_missing_text_preserve_full_original(self):
        src=source()
        cases=[[],[word('第一句',0,1)],[word('第一句',0,3),word('第二句',2,4)],
               [word('第一句',-1,1),word('第二句',2,4)],[word('第一句',0,float('nan'))],
               [word('第一句',0,1),word('第二句',2,4.1)],[word('第一句',0,0),word('第二句',0,0)]]
        for words in cases:
            with self.subTest(words=words):
                rows,warning=module.align_segment(src,words,'one')
                self.assertEqual(len(rows),1)
                self.assertEqual(rows[0]['text'],src['text'])
                self.assertEqual((rows[0]['start'],rows[0]['end']),(0,4))
                self.assertEqual(warning['code'],'sentence_alignment_unresolved')

    def test_twenty_second_processing_window_is_not_a_clip_boundary(self):
        data=dict(sample_rate=RATE,duration=23,segments=[source('一句还没说完，',duration=20),source('继续说。',start=20,duration=3)])
        original=copy.deepcopy(data)
        def align(text,audio):
            return [word(text,.1,len(audio)/RATE-.1)]
        result=module.align_transcript(data,pcm(23),align,detector=lambda _:[dict(start=0,end=23*RATE)])
        self.assertEqual(len(result['segments']),1)
        row=result['segments'][0]
        self.assertEqual(row['text'],'一句还没说完，继续说。')
        self.assertEqual((row['start'],row['end']),(0,23))
        self.assertEqual(len(row['source_segment_ids']),2)
        self.assertEqual(len(row['speech_spans']),1)
        self.assertNotIn('source_text_start',row)
        self.assertEqual(result['alignment_summary']['continuous_window_joins'],1)
        self.assertEqual(data,original)

    def test_real_pause_near_twenty_seconds_keeps_two_audio_clips(self):
        data=dict(sample_rate=RATE,duration=23,segments=[source('前一段',duration=20),source('后一段',start=20,duration=3)])
        result=module.align_transcript(data,pcm(23,[(19.7,20.3)]),lambda text,audio:[word(text,0,len(audio)/RATE)],
            detector=lambda _:[dict(start=0,end=round(19.7*RATE)),dict(start=round(20.3*RATE),end=23*RATE)])
        self.assertEqual(len(result['segments']),2)
        self.assertEqual(result['alignment_summary']['continuous_window_joins'],0)

    def test_original_separate_vad_pauses_are_not_joined_for_missing_full_stop(self):
        data=dict(sample_rate=RATE,duration=5,segments=[source('前段',duration=2),source('后段',start=3,duration=2)])
        result=module.align_transcript(data,pcm(5,[(2,3)]),lambda text,audio:[word(text,0,len(audio)/RATE)],
            detector=lambda _:[dict(start=0,end=2*RATE),dict(start=3*RATE,end=5*RATE)])
        self.assertEqual([r['text'] for r in result['segments']],['前段','后段'])

    def test_three_continuous_windows_have_one_span_and_all_source_ids(self):
        data=dict(sample_rate=RATE,duration=6,segments=[source(t,start=i*2,duration=2) for i,t in enumerate(['第一段，','第二段。','第三段'])])
        result=module.align_transcript(data,pcm(6),lambda text,audio:[word(text,0,2)],detector=lambda _:[dict(start=0,end=6*RATE)])
        self.assertEqual(len(result['segments']),1)
        self.assertEqual(len(result['segments'][0]['source_segment_ids']),3)
        self.assertEqual(len(result['segments'][0]['speech_spans']),1)
        self.assertEqual(result['segments'][0]['text'],'第一段，第二段。第三段')

    def test_silent_audio_with_stale_text_is_not_reported_as_verified_speech(self):
        data=dict(sample_rate=RATE,duration=4,segments=[source()])
        result=module.align_transcript(data,[0]*64000,lambda *_:[word('第一句',.7,1.5),word('第二句',2,3.2)],detector=lambda _:[])
        self.assertTrue(result['segments'][0]['needs_review'])
        self.assertEqual((result['segments'][0]['start'],result['segments'][0]['end']),(0,4))
        self.assertEqual(result['warnings'][0]['code'],'acoustic_speech_unresolved')

    def test_invalid_audio_and_source_range_fail_explicitly(self):
        data=dict(sample_rate=RATE,duration=4,segments=[source()])
        for change in [dict(sample_rate=44100),dict(duration=5),dict(segments=[source(),source()])]:
            with self.assertRaises(ValueError):
                module.align_transcript({**data,**change},pcm(4),lambda *_:[],detector=lambda _:[])
        def broken(*_):
            raise RuntimeError('alignment failed')
        result=module.align_transcript(data,pcm(4),broken,detector=lambda _:[dict(start=0,end=4*RATE)])
        self.assertEqual(len(result['segments']),1)
        self.assertIn('对齐引擎失败',result['warnings'][0]['reason'])


if __name__=='__main__':
    unittest.main()
