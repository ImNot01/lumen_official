import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { mapAuthError } from '../lib/errors'
import { Spinner } from './ui'

type Props = {
  disabled?: boolean
  onError: (message: string | null) => void
}

export default function GoogleSignInButton({ disabled = false, onError }: Props) {
  const [busy, setBusy] = useState(false)

  async function signIn() {
    onError(null)
    setBusy(true)
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      })
      if (error) {
        onError(mapAuthError(error.message))
        setBusy(false)
      }
    } catch (error) {
      onError(mapAuthError(error instanceof Error ? error.message : 'Something went wrong.'))
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void signIn()}
      disabled={disabled || busy}
      className="btn w-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-100 dark:hover:bg-white/10"
    >
      {busy ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 48 48">
          <path fill="#4285F4" d="M43.6 24.5c0-1.6-.1-3.1-.4-4.5H24v9.1h11a9.5 9.5 0 0 1-3.8 5.7v4.7h6.2c3.6-3.3 5.7-8.2 5.7-15Z" />
          <path fill="#34A853" d="M24 44c5.4 0 9.9-1.8 13.2-4.9L31 34.4c-1.8 1.2-4.1 2-7 2-5.3 0-9.8-3.6-11.4-8.4H6.2v4.9C9.5 39.5 16.2 44 24 44Z" />
          <path fill="#FBBC05" d="M12.6 28a12 12 0 0 1 0-7.9v-4.9H6.2a20 20 0 0 0 0 18.1l6.4-4.9Z" />
          <path fill="#EA4335" d="M24 11.7c2.9 0 5.5 1 7.5 2.9l5.6-5.6C33.9 5.7 29.4 4 24 4 16.2 4 9.5 8.5 6.2 15.1l6.4 4.9c1.6-4.8 6.1-8.3 11.4-8.3Z" />
        </svg>
      )}
      {busy ? 'Connecting to Google…' : 'Continue with Google'}
    </button>
  )
}
