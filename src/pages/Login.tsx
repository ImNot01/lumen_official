import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { mapAuthError } from '../lib/errors'
import { Alert, AuthShell, Field, Spinner } from '../components/ui'
import GoogleSignInButton from '../components/GoogleSignInButton'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (err) setError(mapAuthError(err.message))
    } catch (ex) {
      setError(mapAuthError(ex instanceof Error ? ex.message : 'Something went wrong.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your private conversations."
      footer={
        <>
          New to Lumen? <Link to="/register" className="link">Create an account</Link>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        <GoogleSignInButton onError={setError} disabled={busy} />
      </div>
      <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
        <span>or sign in with email</span>
        <span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
      </div>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" id="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <Field label="Password" id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" />
        <div className="text-right text-sm">
          <Link to="/forgot" className="link">Forgot password?</Link>
        </div>
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy && <Spinner className="h-4 w-4" />} Sign in
        </button>
      </form>
    </AuthShell>
  )
}
