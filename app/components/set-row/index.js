Component({
  properties: {
    no: { type: Number, value: 1 },
    weight: { type: Number, value: 0 },
    reps: { type: Number, value: 0 },
    unit: { type: String, value: 'kg' },   // kg | bw（自重） | sec（计时）
    done: { type: Boolean, value: false },
    pr: { type: Boolean, value: false },
    editable: { type: Boolean, value: true }
  },

  data: {
    wDisplay: '',      // 输入框显示值（受控，避免父级刷新时冲掉输入）
    rDisplay: '',
    showKg: true,
    repsSuffix: ''
  },

  observers: {
    'weight': function (w) {
      const s = w > 0 ? String(w) : '';
      if (s !== this.data.wDisplay) this.setData({ wDisplay: s });
    },
    'reps': function (r) {
      const s = String(r == null ? '' : r);
      if (s !== this.data.rDisplay) this.setData({ rDisplay: s });
    },
    'unit': function (unit) {
      this.setData({
        showKg: unit !== 'bw',
        repsSuffix: unit === 'sec' ? '″' : ''
      });
    }
  },

  methods: {
    /** 重量：失焦 / 回车才提交，输入过程中不动父级 */
    onWeightBlur(e) {
      if (!this.data.editable) return;
      const raw = String(e.detail.value || '').trim();
      let v = raw === '' ? 0 : Number(raw);

      if (isNaN(v) || v < 0) v = this.data.weight;    // 非法输入 → 回滚
      v = Math.round(v * 10) / 10;                     // 最多一位小数

      this.setData({ wDisplay: v > 0 ? String(v) : '' });
      if (v !== this.data.weight) {
        this.triggerEvent('weightchange', { no: this.data.no, value: v });
      }
    },

    /** 次数 / 秒数 */
    onRepsBlur(e) {
      if (!this.data.editable) return;
      const raw = String(e.detail.value || '').trim();
      let v = raw === '' ? 0 : Number(raw);

      if (isNaN(v) || v < 0) v = this.data.reps;       // 非法输入 → 回滚
      v = Math.round(v);

      this.setData({ rDisplay: String(v) });
      if (v !== this.data.reps) {
        this.triggerEvent('repschange', { no: this.data.no, value: v });
      }
    },

    onToggle() {
      this.triggerEvent('toggle', { no: this.data.no });
    }
  }
});
