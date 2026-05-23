#include "globals.h"

volatile int g_counter = 0;
int g_mode = 0;
int g_interruptFlag = 0;
int g_buffer[8] = {0};
DEVICE_STATE g_deviceState = {0, 0, 0};
DEVICE_STATE g_devices[2] = {{0, 0, 0}, {0, 0, 0}};

void CommonUpdate(void)
{
    g_mode = g_counter;
    g_deviceState.mode = g_counter;
}

unsigned long WorkerThread(void *param)
{
    DEVICE_STATE *pState = &g_deviceState;
    g_counter++;
    pState->counter++;
    MacroAliasUse(pState);
    CommonUpdate();
    return 0;
}

void MonitorThread(void)
{
    if (g_counter > 10 && g_deviceState.counter > 10) {
        g_mode = 2;
        g_devices[0].status = g_deviceState.mode;
    }
}

void InterruptHandler(void)
{
    g_interruptFlag = g_counter;
    g_deviceState.counter = 0;
    g_counter = 0;
}

void PointerAlias(void)
{
    int *p = &g_mode;
    *p = 4;
}

void MacroAliasUse(DEVICE_STATE *pState)
{
    pState->DEVICE_MODE_MEMBER = DEVICE_COUNTER_ALIAS;
}

void PointerMemberUnknown(DEVICE_STATE *pState)
{
    pState->mode = 4;
}
