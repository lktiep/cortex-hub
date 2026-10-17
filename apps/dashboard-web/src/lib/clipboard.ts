// navigator.clipboard only exists in a secure context; a dashboard opened over plain
// http on a LAN address gets the textarea fallback instead.
function copyTextFallback(text: string): boolean {
  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.style.top = '0'
  textArea.style.left = '0'
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  let success = false
  try {
    success = document.execCommand('copy')
  } catch (err) {
    console.error('Fallback copy failed:', err)
  }
  document.body.removeChild(textArea)
  return success
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (e) {
    console.warn('Modern clipboard API failed, trying fallback:', e)
  }
  return copyTextFallback(text)
}
