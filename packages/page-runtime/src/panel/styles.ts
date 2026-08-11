/* Shadow DOM panel styles: isolated from the target application CSS. */

export const PANEL_STYLES = `
:host {
  all: initial;
}
.dsh-bb-host {
  position: fixed;
  inset: auto 16px 16px auto;
  z-index: 2147483000;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #1f2933;
}
.dsh-bb-launcher {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #cbd2d9;
  border-radius: 16px;
  background: #ffffff;
  color: #1f2933;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.dsh-bb-launcher:hover {
  border-color: #2680eb;
}
.dsh-bb-drawer {
  display: flex;
  flex-direction: column;
  width: 360px;
  height: min(520px, 70vh);
  border: 1px solid #cbd2d9;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.dsh-bb-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #e4e7eb;
  background: #f5f7fa;
  font-weight: 600;
}
.dsh-bb-close {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  color: #52606d;
}
.dsh-bb-connection {
  padding: 6px 10px;
  border-bottom: 1px solid #e4e7eb;
  font-size: 12px;
  color: #52606d;
}
.dsh-bb-connection[data-state='connected'] {
  color: #147d64;
}
.dsh-bb-connection[data-state='failed'] {
  color: #b3341c;
}
.dsh-bb-actions {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #e4e7eb;
}
.dsh-bb-retry {
  border: 1px solid #cbd2d9;
  border-radius: 6px;
  background: #ffffff;
  padding: 2px 8px;
  cursor: pointer;
}
.dsh-bb-fallback {
  color: #2680eb;
  text-decoration: none;
  padding-top: 4px;
}
.dsh-bb-frame {
  flex: 1;
  min-height: 0;
}
.dsh-bb-frame iframe {
  width: 100%;
  height: 100%;
  border: none;
}
.dsh-bb-resize-handle {
  width: 6px;
  cursor: ew-resize;
  background: transparent;
}
`
