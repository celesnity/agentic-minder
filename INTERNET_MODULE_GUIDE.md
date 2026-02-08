# Adding InternetModule to Your Scene

## Quick Instructions

The `VectorIngestController` requires an **InternetModule** asset to communicate with the VectorDB server over WebSocket.

### Steps in Lens Studio:

1. **Add InternetModule Asset**
   - Open **Resources Panel** (usually bottom panel)
   - Right-click in empty space
   - Select **Add New** → **Internet Module**
   - A new asset appears: "InternetModule"

2. **Wire to VectorIngestController**
   - In **Objects Panel**, find and select **SummaryStorage**
   - In **Inspector Panel**, scroll to **VectorIngestController** component
   - Find the **internetModule** field (should show "None")
   - Drag the **InternetModule** asset from Resources Panel into this field
   - Field should now show "InternetModule"

3. **Verify Configuration**
   In the same **VectorIngestController** component, check:
   - ☑️ **useRemoteVectorService** is checked
   - 📝 **remoteWsUrl** shows `ws://YOUR_IP:8787/ws`
   - ☑️ **enableIngestion** is checked
   - ☑️ **enableDebugLogging** is checked
   - 🔗 **summaryASRController** is connected
   - 🔗 **summaryStorage** is connected
   - 🔗 **internetModule** is connected (NEW!)

### What if I can't find "Internet Module"?

If the option doesn't appear in the "Add New" menu:

**Option A**: Check Lens Studio Version
- InternetModule requires Lens Studio 5.0+ with Spectacles support
- Update to latest version if needed

**Option B**: Manual Asset Creation
- Create a `.lsasset` file (see below)

**Option C**: Use Preview Mode Only
- Leave `internetModule` empty
- Set `useRemoteVectorService: false`
- This uses on-device storage (no network needed)

## Manual InternetModule Creation (if needed)

If you can't add InternetModule through the UI, create this file:

**File**: `Assets/AgenticPlayground/Resources/InternetModule.lsasset`

```yaml
- !<InternetModule/12345678-1234-1234-1234-123456789abc>
  Name: Internet Module
  PackageType: NotAPackage
```

Then in Scene.scene, update VectorIngestController's internetModule reference:
```yaml
internetModule: !<reference> 12345678-1234-1234-1234-123456789abc
```

## Verification

After adding, run the Lens and check logs:

✅ **Success**:
```
VectorIngestController: ✅ InternetModule connected
VectorIngestController: 🔌 Remote client created for ws://...
```

❌ **Still Missing**:
```
VectorIngestController: ⚠️ WARNING - useRemoteVectorService=true but InternetModule not assigned!
```

## Alternative: Disable Remote Mode

If you can't get InternetModule working, you can use local on-device mode:

1. In **VectorIngestController** component:
   - **Uncheck** `useRemoteVectorService`
   - Leave `internetModule` empty
2. This uses on-device Persistent Storage vector store
3. Works without network, but:
   - No central VectorDB
   - Limited by device memory
   - No cross-session persistence

## Need Help?

Check `VECTORDB_SETUP.md` for full troubleshooting guide.
