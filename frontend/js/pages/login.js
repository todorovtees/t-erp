import { supabase } from '../lib/supabaseClient.js';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const btn = document.getElementById('login-btn');

// If already logged in, skip straight to the dashboard.
supabase.auth.getSession().then(({ data: { session } }) => {
  if (session) window.location.href = './index.html';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Вход…';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    errorBox.textContent = 'Грешен имейл или парола.';
    errorBox.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Вход';
    return;
  }

  window.location.href = './index.html';
});
