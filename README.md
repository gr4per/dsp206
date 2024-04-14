# DSP206 

Is a very thin client lib for the proprietary Ethernet protocol of the device.
It does not work with the USB interface.

## Installing

I never released this as module on a package registry.
This means you can include the dsp206.js as source code.

You wil also have to make the dependencies available, see the package.json file.

It exports the Dsp206 class which is your interface.
It requires the IP address of your DSP206 device. 

See also the end of the file where the setup example is in the test function.

## Supported commands

You can use the generic sendCommand function to send any command to the device.
As to the command codes, they are listed in the DSP206_spec.txt file.

For convenience, many commands are wrapped in high level js functions that are much easier to consume.

## Proxying the DSP 206

The index.js contains a proxy example that filters the logon auth which allows running the DSP206 UI via the proxy and through the proxy skip auth.
This is just included for convenience as I found it useful for debugging.
