"""Stable error envelopes for route responses, including legacy transport errors."""
from contextvars import ContextVar
from fastapi.responses import JSONResponse as FastAPIJSONResponse

request_id: ContextVar[str] = ContextVar('atelier_request_id', default='')


class JSONResponse(FastAPIJSONResponse):
    def __init__(self, content, status_code=200, **kwargs):
        if status_code >= 400 and isinstance(content, dict):
            message=content.get('message') or content.get('detail') or content.get('error') or '请求失败'
            if isinstance(message,dict): message=message.get('message') or str(message)
            content={**content,'code':content.get('code','request_error'),'message':str(message),'request_id':request_id.get()}
        super().__init__(content=content,status_code=status_code,**kwargs)
