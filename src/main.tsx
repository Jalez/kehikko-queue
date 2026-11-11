import './index.css'

/* For its side effect: installs the mailbox before React mounts, so a host's
   greeting that arrives early is held rather than lost. */
import 'kehikot-module-protocol/client'
/* StrictMode and ReportErrors around the page (protocol 2.70.0): a render that throws is said to the
   host and drawn as text, and a missing root is said as a page failure rather than left blank. */
import { mountPage } from 'kehikot-module-protocol/client/mount'
import { App } from './app.tsx'

mountPage('root', <App />)
