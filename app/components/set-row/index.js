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
    // 计时动作（sec）不显示重量列；bw 的重量是「额外负重」，不标 kg 免得被当体重
    showWeight: true,
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
      this.applyUnit(unit);
    }
  },

  // 首帧兜底：observers 依赖属性初始化触发，这里再算一次，避免秒数行闪一下重量框
  attached() {
    this.applyUnit(this.data.unit);
  },

  methods: {
    /** 重量列的显隐与后缀，全看 unit */
    applyUnit(unit) {
      this.setData({
        showWeight: unit !== 'sec',   // 平板支撑这类只记秒数
        showKg: unit === 'kg',
        repsSuffix: unit === 'sec' ? '″' : ''
      });
    },

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
