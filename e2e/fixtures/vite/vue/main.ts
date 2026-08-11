import { createApp, h, ref } from 'vue'

const App = {
  setup() {
    const value = ref('')
    return () => h('div', [
      h('label', { for: 'input' }, 'Input'),
      h('input', {
        id: 'input',
        value: value.value,
        onInput: (event: Event) => {
          value.value = (event.target as HTMLInputElement).value
        },
      }),
      h('span', { id: 'rendered' }, value.value),
    ])
  },
}

createApp(App).mount('#app')
