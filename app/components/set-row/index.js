Component({
  properties: {
    no: { type: Number, value: 1 },
    weight: { type: Number, value: 0 },
    reps: { type: Number, value: 0 },
    unit: { type: String, value: 'kg' },
    done: { type: Boolean, value: false },
    pr: { type: Boolean, value: false }
  },

  data: {
    weightText: '自重',
    repsText: ''
  },

  observers: {
    'weight, reps, unit': function (weight, reps, unit) {
      let w = '自重';
      if (weight > 0) w = weight + ' kg';
      let r = '' + reps;
      if (unit === 'sec') r = reps + '″';
      this.setData({ weightText: w, repsText: r });
    }
  },

  methods: {
    onToggle() {
      this.triggerEvent('toggle', { no: this.data.no });
    }
  }
});
