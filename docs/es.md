# Vestel EVC04 Home – integración con Gladys Assistant

Esta integración comunitaria conecta una wallbox Vestel EVC04 Home con [Gladys Assistant](https://gladysassistant.com/) mediante **Modbus TCP**. Lee las mediciones de carga y controla localmente la corriente de carga permitida. No necesita la nube del fabricante, un backend OCPP ni una cuenta de usuario.

## Requisitos

- Gladys Assistant **5.1.0 o posterior**.
- Modbus TCP activado en la wallbox.
- La wallbox y el host de Gladys deben estar accesibles en la misma red.
- Puerto Modbus TCP predeterminado: **502**. Unit ID predeterminado: **255**.

La EVC04 solo admite **un maestro Modbus a la vez**. Por ello, la integración comparte una única conexión para mediciones, pruebas de conexión y comandos de control. No conectes otro cliente Modbus a la wallbox simultáneamente.

## Instalación y configuración

Instala la integración desde el sistema de integraciones de Gladys. La imagen del contenedor está publicada en:

`ghcr.io/tomgermany/gladys-vestel-evc04:latest`

Configura la dirección IP o el nombre mDNS de la wallbox (sin `http://`), el puerto Modbus, el Unit ID, el intervalo de lectura de las mediciones y el plazo del heartbeat. Se recomienda reservar la dirección mediante DHCP para mantener una dirección estable.

| Ajuste | Valor predeterminado | Descripción |
| --- | --- | --- |
| Dirección de la wallbox | — | Dirección IP o nombre mDNS |
| Puerto Modbus | `502` | Cámbialo solo si la wallbox utiliza otro puerto |
| Unit ID Modbus | `255` | Unit ID predeterminado de la EVC04 |
| Intervalo de actualización | 5 minutos | Opciones: 1, 5, 15, 30 o 60 minutos |
| Plazo del heartbeat | 20 segundos | Se utiliza cuando el control de corriente está activo |

Después de guardar la configuración, utiliza **Comprobar conexión** para probar la comunicación mediante la conexión existente.

## Mediciones y actualización

La integración publica en Gladys el estado de carga, la potencia, la corriente, la tensión y la energía. El intervalo determina la frecuencia con la que se actualizan estos valores. Los errores de lectura quedan registrados y la integración intenta una vez restablecer la conexión mediante un socket nuevo. Con un intervalo de cinco minutos, un problema de conectividad puede no detectarse hasta la siguiente lectura programada.

## Control de corriente de carga y heartbeat

La integración configura la corriente permitida mediante el registro Modbus `5004`. La wallbox no dispone de un comando independiente de inicio/parada: la carga comienza o termina según si el vehículo consume corriente.

- La corriente solicitada se limita a un mínimo de **6 A** y al máximo permitido por la wallbox y el cable.
- El widget del panel permite aumentar o reducir la corriente en pasos configurables de **1, 2 o 5 A**.
- Las escenas de Gladys pueden fijar un valor con la acción **Establecer corriente de carga**.
- Mientras se mantiene activo el control de corriente, la integración envía un heartbeat mediante el registro `6000`. Con el plazo predeterminado de 20 segundos, se envía aproximadamente cada 10 segundos, con un intervalo mínimo de 3 segundos.
- Si deja de llegar el heartbeat, la wallbox vuelve a su corriente de seguridad. Este mecanismo es independiente del intervalo de medición y no puede reiniciar una wallbox cuyo firmware se haya bloqueado.

## Escenas de Gladys

La integración ofrece **dos activadores de escena** y **una acción de escena**.

### Activadores de escena

- **Wallbox cargando** — se activa al entrar en el estado de carga.
- **Carga de la wallbox finalizada** — se activa al salir de ese estado.

Según el activador, hay variables disponibles como potencia, corriente de carga, lectura del contador, energía de la sesión y duración.

### Acción de escena

- **Establecer corriente de carga** — permite que una escena establezca la corriente de carga deseada en amperios. El valor se limita a un mínimo de **6 A** y al máximo permitido por la wallbox y el cable.

## Solución de problemas

- **Sin respuesta:** comprueba la dirección, la conexión de red y que Modbus TCP esté activado.
- **Unit ID incorrecto:** el valor predeterminado es `255`, no `1`.
- **Conexión ocupada:** asegúrate de que no haya otro cliente Modbus conectado a la EVC04.
- **Mediciones desactualizadas:** revisa el intervalo o ejecuta **Comprobar conexión**.
- **Wallbox bloqueada:** el heartbeat puede hacer que se utilice la corriente de seguridad, pero la integración no puede cortar y restablecer la alimentación ni reparar un bloqueo del firmware.

## Aviso sobre marcas y fabricante

Esta es una integración comunitaria independiente para Gladys Assistant. No está desarrollada, respaldada ni aprobada oficialmente por Vestel. **Vestel** y **EVC04** son denominaciones del fabricante. Las marcas, los logotipos y las representaciones de productos pertenecen a sus respectivos titulares y se utilizan únicamente para identificar el producto compatible.

## Licencia

Apache-2.0.
