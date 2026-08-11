const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <button id="counter">Counter</button>
  <span id="clicks">0</span>
`

document.querySelector<HTMLButtonElement>('#counter')!.addEventListener('click', () => {
  const current = Number(document.querySelector<HTMLSpanElement>('#clicks')!.textContent)
  document.querySelector<HTMLSpanElement>('#clicks')!.textContent = String(current + 1)
})

document.querySelector<HTMLButtonElement>('#save')!.addEventListener('click', () => {
  document.querySelector<HTMLDivElement>('#status')!.textContent = 'saved'
})

if (import.meta.hot) {
  import.meta.hot.accept()
}
