/**
 * DSH Icon Studio — client half.
 *
 * Adds one settings page: upload a PNG, look at the generated icon set, then
 * press Apply to write it into the tray, the Desktop/Start Menu shortcuts, and
 * the executable's icon resources. Every file operation stays in the Host half;
 * this module only picks a file, shows a preview, and calls the plugin's own
 * `/api/dsh-icon-studio/*` routes with a confirm step in between.
 *
 * Styling uses host `--dsw-alias-*` tokens with literal fallbacks, so a renamed
 * token changes a shade instead of breaking the panel.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-icon-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useCallback = React.useCallback;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useState = React.useState;

    const API = '/api/dsh-icon-studio';

    const COLORS = {
      card: 'var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.08))',
      layer: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12))',
      border: 'var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.28))',
      borderStrong: 'var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.4))',
      primary: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
      text: 'var(--dsw-alias-label-primary, #f2f3f5)',
      textSecondary: 'var(--dsw-alias-label-secondary, rgba(242, 243, 245, 0.7))',
      textTertiary: 'var(--dsw-alias-label-tertiary, rgba(242, 243, 245, 0.5))',
      onColor: 'var(--dsw-alias-label-on-color, #ffffff)',
      danger: 'var(--dsw-alias-state-error-primary, #f2555a)',
      success: 'var(--dsw-alias-state-success-primary, #3fb950)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16))',
    };

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        fontFamily: 'var(--dsw-font-family)',
        color: COLORS.text,
        maxWidth: '860px',
      },
      card: {
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 'var(--dsw-radius-lg, 16px)',
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      hint: { fontSize: '12.5px', lineHeight: 1.6, color: COLORS.textSecondary, margin: 0 },
      drop: dragOver => ({
        border: `1.5px dashed ${dragOver ? COLORS.primary : COLORS.borderStrong}`,
        borderRadius: 'var(--dsw-radius-md, 12px)',
        background: dragOver ? COLORS.hover : COLORS.layer,
        padding: '26px 18px',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'border-color 120ms ease, background 120ms ease',
      }),
      dropTitle: { fontSize: '13.5px', fontWeight: 500, margin: '0 0 6px' },
      dropHint: { fontSize: '12px', color: COLORS.textTertiary, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      button: (variant, disabled) => {
        const shared = {
          appearance: 'none',
          border: '1px solid transparent',
          borderRadius: 'var(--dsw-radius-sm, 8px)',
          padding: '7px 16px',
          fontSize: '13px',
          fontWeight: 500,
          fontFamily: 'inherit',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          transition: 'background 120ms ease, border-color 120ms ease',
        };
        if (variant === 'primary') {
          return Object.assign(shared, { background: COLORS.primary, color: COLORS.onColor });
        }
        return Object.assign(shared, {
          background: 'transparent',
          borderColor: COLORS.border,
          color: COLORS.text,
        });
      },
      preview: {
        borderRadius: 'var(--dsw-radius-md, 12px)',
        border: `1px solid ${COLORS.border}`,
        background: COLORS.layer,
        width: '100%',
        display: 'block',
      },
      meta: { fontSize: '12px', color: COLORS.textTertiary, margin: 0 },
      statusList: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '7px 16px', fontSize: '12.5px' },
      statusKey: { color: COLORS.textTertiary },
      statusValue: { color: COLORS.textSecondary, wordBreak: 'break-all' },
      error: {
        fontSize: '12.5px',
        lineHeight: 1.5,
        color: COLORS.danger,
        background: 'var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04))',
        border: `1px solid ${COLORS.danger}`,
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        padding: '8px 12px',
        margin: 0,
      },
      notice: {
        fontSize: '12.5px',
        lineHeight: 1.5,
        color: COLORS.success,
        margin: 0,
      },
    };

    async function request(path, init) {
      let response;
      try {
        response = await fetch(API + path, init);
      } catch (error) {
        throw new Error('cannot reach the icon service: ' + (error && error.message ? error.message : String(error)));
      }
      const text = await response.text();
      let body = null;
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      if (!response.ok) {
        const detail = body && typeof body.error === 'string' ? body.error : `${response.status} ${response.statusText}`;
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }
      return body;
    }

    function readAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not read that file'));
        reader.onload = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const comma = result.indexOf(',');
          if (comma < 0) {
            reject(new Error('could not read that file'));
            return;
          }
          resolve(result.slice(comma + 1));
        };
        reader.readAsDataURL(file);
      });
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function row(key, value) {
      return [
        h('div', { key: key + '-k', style: styles.statusKey }, key),
        h('div', { key: key + '-v', style: styles.statusValue }, value),
      ];
    }

    function IconStudioPanel() {
      const [status, setStatus] = useState(null);
      const [pending, setPending] = useState(null);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [dragOver, setDragOver] = useState(false);
      const inputRef = useRef(null);

      const refresh = useCallback(async () => {
        setBusy('status');
        try {
          const body = await request('/status', { method: 'GET' });
          setStatus(body && body.data ? body.data : null);
          setError('');
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy('');
        }
      }, []);

      useEffect(() => {
        let alive = true;
        request('/status', { method: 'GET' })
          .then(body => {
            if (alive) setStatus(body && body.data ? body.data : null);
          })
          .catch(failure => {
            if (alive) setError(failure.message);
          });
        return () => {
          alive = false;
        };
      }, []);

      const accept = useCallback(async file => {
        if (!file) return;
        const isPng = file.type === 'image/png' || /\.png$/i.test(file.name || '');
        if (!isPng) {
          setPending(null);
          setNotice('');
          setError('PNG only. Convert the image first (export it as PNG), then upload it again.');
          return;
        }
        setBusy('build');
        setError('');
        setNotice('');
        try {
          const data = await readAsBase64(file);
          const body = await request('/build', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name || 'upload.png', data }),
          });
          setPending(body);
        } catch (failure) {
          setPending(null);
          setError(failure.message);
        } finally {
          setBusy('');
        }
      }, []);

      const confirmApply = useCallback(async () => {
        if (!pending) return;
        setBusy('apply');
        setError('');
        setNotice('');
        try {
          const body = await request('/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug: pending.slug }),
          });
          const warnings = Array.isArray(body && body.warnings) ? body.warnings : [];
          setNotice('Applied. Restart DeepSeek Harness to load the tray and window icons.' +
            (warnings.length > 0 ? ` (${warnings[0]})` : ''));
          await refresh();
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy('');
        }
      }, [pending, refresh]);

      const restore = useCallback(async () => {
        setBusy('restore');
        setError('');
        setNotice('');
        try {
          const body = await request('/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          setPending(null);
          const warnings = Array.isArray(body && body.warnings) ? body.warnings : [];
          setNotice('Restored the original icons. Restart DeepSeek Harness to see them.' +
            (warnings.length > 0 ? ` (${warnings[0]})` : ''));
          await refresh();
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy('');
        }
      }, [refresh]);

      const onDrop = useCallback(event => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
        accept(file);
      }, [accept]);

      const exe = (status && status.exe) || {};
      const applied = status && status.applied ? status.applied : null;
      const signature = exe.signature && typeof exe.signature.status === 'string' ? exe.signature.status : 'Unknown';
      const busyBuild = busy === 'build';
      const busyApply = busy === 'apply';
      const busyRestore = busy === 'restore';

      let exeIconText;
      if (exe.customIcon === true) {
        exeIconText = 'Custom, applied by this plugin';
      } else if (signature === 'Valid') {
        exeIconText = 'Vendor icon (the binary is still vendor-signed)';
      } else {
        exeIconText = `Changed outside this plugin (binary signature: ${signature})`;
      }

      return h('div', { style: styles.root },
        h('div', { style: styles.card },
          h('h3', { style: styles.title }, 'App icon'),
          h('p', { style: styles.hint },
            'Pick a PNG, get the full 16–256 px icon set, then confirm to write the tray icon, the Desktop and Start Menu shortcuts, and the window/taskbar icon inside the executable.'),
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: 'image/png',
            style: { display: 'none' },
            onChange: event => {
              const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
              accept(file);
              event.target.value = '';
            },
          }),
          h('div', {
            style: styles.drop(dragOver),
            role: 'button',
            tabIndex: 0,
            onClick: () => {
              if (inputRef.current) inputRef.current.click();
            },
            onKeyDown: event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (inputRef.current) inputRef.current.click();
              }
            },
            onDragOver: event => {
              event.preventDefault();
              setDragOver(true);
            },
            onDragLeave: () => setDragOver(false),
            onDrop,
          },
            h('p', { style: styles.dropTitle }, busyBuild ? 'Building the icon set…' : 'Drop a PNG here, or click to choose a file'),
            h('p', { style: styles.dropHint },
              pending
                ? `Built from ${pending.label || pending.slug}`
                : 'Any square or non-square PNG; a white background is removed automatically'),
          ),
          pending
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              h('img', { src: pending.previewUrl, alt: 'Generated icon preview', style: styles.preview }),
              h('p', { style: styles.meta },
                `${(pending.sizes || []).join(' · ')} px · ICO ${formatBytes(pending.icoBytes)} · source ${pending.sourceWidth}×${pending.sourceHeight}${pending.note ? ' · ' + pending.note : ''}`),
            )
            : null,
          h('div', { style: styles.row },
            h('button', {
              type: 'button',
              style: styles.button('primary', !pending || busy !== ''),
              disabled: !pending || busy !== '',
              onClick: confirmApply,
            }, busyApply ? 'Applying…' : 'Apply'),
            h('button', {
              type: 'button',
              style: styles.button('secondary', busy !== ''),
              disabled: busy !== '',
              onClick: restore,
            }, busyRestore ? 'Restoring…' : 'Restore original'),
            h('button', {
              type: 'button',
              style: styles.button('secondary', busy !== ''),
              disabled: busy !== '',
              onClick: refresh,
            }, busy === 'status' ? 'Reading…' : 'Refresh'),
          ),
          error ? h('p', { style: styles.error }, error) : null,
          notice ? h('p', { style: styles.notice }, notice) : null,
        ),
        h('div', { style: styles.card },
          h('h3', { style: styles.title }, 'Current status'),
          h('div', { style: styles.statusList },
            row('Installation', status ? status.installDir : 'reading…'),
            row('Executable icon', exeIconText),
            row('Tray icon', status && status.tray && status.tray.matchesAppliedIcon === true ? 'Matches the applied icon' : 'Does not match the applied icon'),
            row('Signature', signature + (exe.signature && exe.signature.signer ? ` · ${exe.signature.signer}` : '')),
            row('Applied icon', applied ? `${applied.slug} (${applied.appliedAt || 'time unknown'})` : 'None yet'),
            row('Executable SHA-256', exe.sha256 || '—'),
          ),
          h('p', { style: styles.meta },
            'Changing the executable icon drops the vendor signature. A DSH update restores the vendor icon, so apply again after an update.'),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-icon-studio',
          order: 331,
          label: () => 'DSH icons',
        }, IconStudioPanel));
      },
    };
  },
});
