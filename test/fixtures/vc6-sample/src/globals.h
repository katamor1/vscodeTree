#ifndef GLOBALS_H
#define GLOBALS_H

extern volatile int g_counter;
extern int g_mode;
extern int g_interruptFlag;
extern int g_buffer[8];

typedef struct tagDeviceState {
    int mode;
    int counter;
    int status;
} DEVICE_STATE;

extern DEVICE_STATE g_deviceState;
extern DEVICE_STATE g_devices[2];

#define DEVICE_COUNTER_ALIAS g_deviceState.counter
#define DEVICE_MODE_MEMBER mode
#define DEVICE_FUNCTION_LIKE(x) x

void CommonUpdate(void);
unsigned long WorkerThread(void *param);
void MonitorThread(void);
void InterruptHandler(void);
void PointerAlias(void);
void MacroAliasUse(DEVICE_STATE *pState);
void PointerMemberUnknown(DEVICE_STATE *pState);

#endif
